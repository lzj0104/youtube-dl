const { spawn } = require('child_process');
const path = require('path');

/**
 * 下载队列管理器
 * 管理视频下载队列，控制并发，处理重试
 */
class DownloadQueue {
  constructor(storage, config, ioInstance, telegramService = null) {
    this.storage = storage;
    this.config = config;
    this.io = ioInstance;
    this.telegram = telegramService;

    this.activeDownloads = new Map();  // downloadId -> process
    this.isRunning = false;
    this.isStopping = false;
  }

  /**
   * 添加到下载队列
   * @param {string} videoId - 视频ID
   * @param {string} quality - 画质
   * @returns {string} - 下载任务ID
   */
  async enqueue(videoId, quality) {
    const downloadId = await this.storage.createDownload(videoId, quality);
    console.log(`📥 加入下载队列: ${videoId} [${quality}] (任务ID: ${downloadId})`);

    // 触发队列处理
    if (this.isRunning && this.activeDownloads.size < this.config.maxConcurrentDownloads) {
      setImmediate(() => this._processQueue());
    }

    return downloadId;
  }

  /**
   * 启动队列处理
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  下载队列已在运行');
      return;
    }

    console.log(`✅ 启动下载队列 (最大并发: ${this.config.maxConcurrentDownloads})`);
    this.isRunning = true;
    this.isStopping = false;

    // 启动处理循环
    this._processQueue();
  }

  /**
   * 优雅停止队列
   */
  async stop() {
    console.log('🛑 停止下载队列...');
    this.isStopping = true;
    this.isRunning = false;

    // 等待所有活跃下载完成
    const activeIds = Array.from(this.activeDownloads.keys());
    if (activeIds.length > 0) {
      console.log(`⏳ 等待 ${activeIds.length} 个活跃下载完成...`);

      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (this.activeDownloads.size === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);
      });
    }

    console.log('✅ 下载队列已停止');
  }

  /**
   * 队列处理循环
   */
  async _processQueue() {
    if (this.isStopping || !this.isRunning) {
      return;
    }

    try {
      // 检查并发限制
      if (this.activeDownloads.size >= this.config.maxConcurrentDownloads) {
        // 达到并发上限，等待5秒后重试
        setTimeout(() => this._processQueue(), 5000);
        return;
      }

      // 获取下一个待下载任务
      const pending = await this.storage.getPendingDownloads(1);

      if (pending.length === 0) {
        // 队列为空，等待10秒后重试
        setTimeout(() => this._processQueue(), 10000);
        return;
      }

      const download = pending[0];

      // 启动下载 (不await，并发执行)
      this._downloadNext(download);

      // 立即尝试处理下一个任务
      setImmediate(() => this._processQueue());

    } catch (error) {
      console.error('❌ 队列处理错误:', error);
      setTimeout(() => this._processQueue(), 10000);
    }
  }

  /**
   * 下载单个视频
   */
  async _downloadNext(download) {
    const { id, videoId, quality } = download;

    try {
      // 获取视频信息
      const video = await this.storage.getVideo(videoId);
      if (!video) {
        console.error(`❌ 视频不存在: ${videoId}`);
        await this.storage.updateDownloadStatus(id, 'failed', {
          errorMessage: '视频信息不存在'
        });
        return;
      }

      console.log(`\n🚀 开始下载: ${video.title} [${quality}]`);

      // 更新状态为 downloading
      await this.storage.updateDownloadStatus(id, 'downloading');

      // 执行下载
      const success = await this._executeDownload(id, video, quality);

      if (success) {
        // 下载成功
        const fileName = this._sanitizeFileName(video.title) + '.mp4';
        const filePath = path.join(this.config.outputPath || './downloads', fileName);

        await this.storage.updateDownloadStatus(id, 'completed', {
          filePath,
          completedAt: new Date().toISOString()
        });

        console.log(`✅ 下载完成: ${video.title}\n`);

        // 推送完成事件
        if (this.io) {
          this.io.emit('download:complete', {
            downloadId: id,
            videoId,
            title: video.title,
            status: 'completed'
          });
        }

        // Telegram 通知（异步发送，不阻塞流程）
        if (this.telegram) {
          const channel = this.storage.data.channels.find(
            ch => ch.id === video.channelId
          );

          setImmediate(async () => {
            try {
              await this.telegram.notifyDownloadComplete(video, channel, filePath);
            } catch (error) {
              console.error('[Telegram] 通知发送异常:', error.message);
            }
          });
        }

      } else {
        // 下载失败，尝试重试
        await this._handleFailure(id, videoId, video.title);
      }

    } catch (error) {
      console.error(`❌ 下载异常 [${videoId}]: ${error.message}`);
      await this._handleFailure(id, videoId, error.message);
    } finally {
      // 从活跃列表移除
      this.activeDownloads.delete(id);
    }
  }

  /**
   * 执行yt-dlp下载
   */
  _executeDownload(downloadId, video, quality) {
    return new Promise((resolve, reject) => {
      const qualityMap = {
        '1080p': 'bestvideo[height<=1080]+bestaudio/best',
        '720p': 'bestvideo[height<=720]+bestaudio/best',
        '480p': 'bestvideo[height<=480]+bestaudio/best'
      };

      const outputPath = this.config.outputPath || './downloads';
      const args = [
        '-f', qualityMap[quality] || qualityMap['720p'],
        '--merge-output-format', 'mp4',
        '-o', `${outputPath}/%(title)s.%(ext)s`,
        '--newline',
        '--write-thumbnail',
        '--convert-thumbnails', 'jpg',
        '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--extractor-args', 'youtube:player_client=android',
        '--no-check-certificate',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '--referer', 'https://www.youtube.com/',
        video.url
      ];

      const proc = spawn('yt-dlp', args);
      this.activeDownloads.set(downloadId, proc);

      let lastProgress = 0;

      proc.stdout.on('data', (data) => {
        const line = data.toString();

        // 解析进度: [download] 45.8% of 125.50MiB at 5.20MiB/s
        const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
        const speedMatch = line.match(/at\s+(\S+)/);

        if (progressMatch) {
          const progress = parseFloat(progressMatch[1]);
          const speed = speedMatch ? speedMatch[1] : '';

          // 只在进度变化>=5%时推送更新 (减少IO)
          if (progress - lastProgress >= 5 || progress === 100) {
            lastProgress = progress;

            if (this.io) {
              this.io.emit('download:progress', {
                downloadId,
                videoId: video.id,
                title: video.title,
                progress,
                speed,
                status: 'downloading'
              });
            }
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const errorMsg = data.toString();
        console.error(`   ⚠️  下载警告: ${errorMsg.substring(0, 200)}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(true);
        } else {
          reject(new Error(`yt-dlp退出码: ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * 处理下载失败
   */
  async _handleFailure(downloadId, videoId, errorMessage) {
    const download = await this.storage.getPendingDownloads(100);
    const currentDownload = download.find(d => d.id === downloadId);

    if (!currentDownload) {
      console.error(`❌ 下载记录不存在: ${downloadId}`);
      return;
    }

    const retryCount = currentDownload.retryCount || 0;

    if (retryCount < 2) {
      // 重试最多2次
      console.log(`🔄 下载失败，准备重试 (${retryCount + 1}/2): ${videoId}`);
      await this.storage.retryFailedDownload(downloadId);

      // 推送重试事件
      if (this.io) {
        this.io.emit('download:retry', {
          downloadId,
          videoId,
          retryCount: retryCount + 1
        });
      }

    } else {
      // 已重试过，标记为彻底失败
      console.error(`❌ 下载彻底失败 (已重试2次): ${videoId}\n`);
      await this.storage.updateDownloadStatus(downloadId, 'failed', {
        errorMessage: errorMessage?.substring(0, 500),
        completedAt: new Date().toISOString()
      });

      // 推送失败事件
      if (this.io) {
        this.io.emit('download:failed', {
          downloadId,
          videoId,
          errorMessage
        });
      }
    }
  }

  /**
   * 文件名清理
   */
  _sanitizeFileName(title) {
    return title
      .replace(/[<>:"/\\|?*]/g, '_')  // 替换非法字符
      .replace(/\s+/g, ' ')           // 合并多个空格
      .trim()
      .substring(0, 200);             // 限制长度
  }

  /**
   * 获取队列状态
   */
  async getStatus() {
    const stats = await this.storage.getDownloadStats();

    return {
      running: this.isRunning,
      active: this.activeDownloads.size,
      pending: stats.pending,
      completed: stats.completed,
      failed: stats.failed,
      maxConcurrent: this.config.maxConcurrentDownloads
    };
  }
}

module.exports = DownloadQueue;
