const cron = require('node-cron');
const { fetchChannelVideosBasic } = require('./utils');

/**
 * 监控调度器
 * 定期检查所有启用的频道，发现新视频自动加入下载队列
 */
class MonitoringScheduler {
  constructor(storage, queueManager, config, ioInstance) {
    this.storage = storage;
    this.queueManager = queueManager;
    this.config = config;
    this.io = ioInstance;

    this.cronTask = null;
    this._isChecking = false;  // 防止重叠检查
  }

  /**
   * 启动定时任务
   */
  start() {
    if (this.cronTask) {
      console.log('⚠️  调度器已在运行');
      return;
    }

    const intervalMinutes = Math.floor(this.config.checkInterval / 60000);
    console.log(`✅ 启动监控调度器 (间隔: ${intervalMinutes}分钟)`);

    // 使用 node-cron 创建定时任务
    // 格式: */5 * * * * = 每5分钟执行一次
    const cronPattern = `*/${intervalMinutes} * * * *`;

    this.cronTask = cron.schedule(cronPattern, async () => {
      await this.checkAllChannelsNow();
    });

    // 启动后立即执行一次检查
    setTimeout(() => {
      this.checkAllChannelsNow();
    }, 5000);
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      console.log('🛑 监控调度器已停止');
    }
  }

  /**
   * 手动立即检查所有频道
   */
  async checkAllChannelsNow() {
    if (this._isChecking) {
      console.log('⏳ 检查任务已在进行中，跳过本次触发');
      return;
    }

    this._isChecking = true;

    try {
      const channels = await this.storage.getChannels(true);  // 只获取启用的频道

      if (channels.length === 0) {
        console.log('ℹ️  没有启用的监控频道');
        return;
      }

      console.log(`\n🔍 开始检查 ${channels.length} 个频道...`);

      const stats = {
        totalChannels: channels.length,
        newVideos: 0,
        errors: 0,
        startedAt: new Date().toISOString()
      };

      // 顺序检查每个频道 (避免并发过多导致限流)
      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];

        try {
          const newCount = await this.checkChannel(channel);
          stats.newVideos += newCount;

          // 频道间延迟5秒，避免YouTube限流
          if (i < channels.length - 1) {
            await this._sleep(5000);
          }
        } catch (error) {
          stats.errors++;
          console.error(`❌ 检查频道失败 [${channel.name || channel.url}]: ${error.message}`);
        }
      }

      stats.completedAt = new Date().toISOString();
      console.log(`\n✅ 检查完成: ${stats.newVideos} 个新视频, ${stats.errors} 个错误\n`);

      // 推送检查完成事件
      if (this.io) {
        this.io.emit('monitoring:check-complete', stats);
      }

    } catch (error) {
      console.error('❌ 监控检查失败:', error);
    } finally {
      this._isChecking = false;
    }
  }

  /**
   * 检查单个频道
   * @param {Object} channel - 频道对象
   * @returns {number} - 新视频数量
   */
  async checkChannel(channel) {
    console.log(`\n📺 检查频道: ${channel.name || channel.url}`);

    try {
      // 1. 获取最新N个视频的基本信息 (快速模式)
      const videos = await fetchChannelVideosBasic(
        channel.url,
        this.config.latestVideosCount
      );

      console.log(`   获取到 ${videos.length} 个最新视频`);

      // 2. 过滤新视频 (去重)
      const newVideos = [];
      for (const video of videos) {
        const exists = await this.storage.videoExists(video.id);
        if (!exists) {
          newVideos.push(video);
        }
      }

      if (newVideos.length === 0) {
        console.log(`   ✓ 没有新视频`);
        await this.storage.updateChannelLastCheck(channel.id);
        return 0;
      }

      console.log(`   🆕 发现 ${newVideos.length} 个新视频`);

      // 3. 添加新视频到数据库 + 加入下载队列
      for (const video of newVideos) {
        // 添加到视频表
        await this.storage.addVideo(channel.id, video);

        // 加入下载队列
        const downloadId = await this.queueManager.enqueue(
          video.id,
          this.config.defaultQuality
        );

        console.log(`   ➕ 已加入队列: ${video.title} [${video.id}]`);

        // 推送新视频事件
        if (this.io) {
          this.io.emit('monitoring:new-video', {
            channelId: channel.id,
            channelName: channel.name,
            video: {
              id: video.id,
              title: video.title,
              url: video.url,
              thumbnail: video.thumbnail
            },
            downloadId
          });
        }
      }

      // 4. 更新频道最后检查时间
      await this.storage.updateChannelLastCheck(channel.id);

      return newVideos.length;

    } catch (error) {
      console.error(`   ❌ 频道检查失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 延迟函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取调度器状态
   */
  getStatus() {
    return {
      running: !!this.cronTask,
      checking: this._isChecking,
      interval: this.config.checkInterval,
      latestVideosCount: this.config.latestVideosCount
    };
  }
}

module.exports = MonitoringScheduler;
