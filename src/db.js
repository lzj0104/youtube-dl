const fs = require('fs');
const path = require('path');

/**
 * JSON文件存储层
 * 用于持久化频道、视频和下载数据
 */
class Storage {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      channels: [],    // 频道列表
      videos: {},      // 视频对象 (videoId -> videoData)
      downloads: []    // 下载记录
    };
  }

  /**
   * 初始化：加载现有文件或创建新文件
   */
  async init() {
    try {
      // 确保目录存在
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 加载现有文件
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(content);
        console.log(`✅ 已加载存储文件: ${this.filePath}`);
      } else {
        await this.save();
        console.log(`✅ 已创建新存储文件: ${this.filePath}`);
      }

      // 启动时重置所有"downloading"状态为"pending"
      let resetCount = 0;
      this.data.downloads.forEach(dl => {
        if (dl.status === 'downloading') {
          dl.status = 'pending';
          resetCount++;
        }
      });
      if (resetCount > 0) {
        await this.save();
        console.log(`🔄 重置 ${resetCount} 个未完成的下载任务`);
      }

      // ✅ 数据迁移：为缺少ID的视频添加ID字段
      let migrated = false;
      for (const [videoId, video] of Object.entries(this.data.videos)) {
        if (!video.id) {
          video.id = videoId;
          migrated = true;
        }
      }

      if (migrated) {
        await this.save();
        console.log('✅ 已迁移视频数据，添加缺失的ID字段');
      }
    } catch (error) {
      console.error('❌ 初始化存储失败:', error);
      // 备份损坏的文件
      if (fs.existsSync(this.filePath)) {
        const backupPath = `${this.filePath}.backup.${Date.now()}`;
        fs.renameSync(this.filePath, backupPath);
        console.log(`⚠️  已备份损坏文件到: ${backupPath}`);
      }
      // 创建新文件
      await this.save();
    }
  }

  /**
   * 保存数据到文件 (原子写入)
   */
  async save() {
    const tempFile = this.filePath + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempFile, this.filePath);
  }

  // ==========================================
  // 频道管理
  // ==========================================

  /**
   * 添加频道
   */
  async addChannel(url, name) {
    // 检查是否已存在
    const existing = this.data.channels.find(ch => ch.url === url);
    if (existing) {
      return existing.id;
    }

    const id = 'ch_' + Date.now();
    const channel = {
      id,
      url,
      name: name || null,
      enabled: true,
      lastCheckAt: null,
      createdAt: new Date().toISOString()
    };
    this.data.channels.push(channel);
    await this.save();
    return id;
  }

  /**
   * 获取频道列表
   */
  async getChannels(enabledOnly = false) {
    if (enabledOnly) {
      return this.data.channels.filter(ch => ch.enabled);
    }
    return this.data.channels;
  }

  /**
   * 切换频道启用状态
   */
  async toggleChannel(id, enabled) {
    const channel = this.data.channels.find(ch => ch.id === id);
    if (channel) {
      channel.enabled = enabled;
      await this.save();
    }
  }

  /**
   * 删除频道
   */
  async removeChannel(id) {
    this.data.channels = this.data.channels.filter(ch => ch.id !== id);
    await this.save();
  }

  /**
   * 更新频道最后检查时间
   */
  async updateChannelLastCheck(id) {
    const channel = this.data.channels.find(ch => ch.id === id);
    if (channel) {
      channel.lastCheckAt = new Date().toISOString();
      await this.save();
    }
  }

  // ==========================================
  // 视频去重
  // ==========================================

  /**
   * 添加视频 (自动去重)
   */
  async addVideo(channelId, videoData) {
    if (!this.data.videos[videoData.id]) {
      this.data.videos[videoData.id] = {
        id: videoData.id,  // ✅ 添加ID字段
        channelId,
        title: videoData.title,
        url: videoData.url,
        thumbnail: videoData.thumbnail,
        duration: videoData.duration || null,
        uploadDate: videoData.upload_date || null,
        discoveredAt: new Date().toISOString()
      };
      await this.save();
      return true;  // 新视频
    }
    return false;  // 已存在
  }

  /**
   * 检查视频是否存在
   */
  async videoExists(videoId) {
    return !!this.data.videos[videoId];
  }

  /**
   * 获取视频信息
   */
  async getVideo(videoId) {
    return this.data.videos[videoId];
  }

  // ==========================================
  // 下载队列
  // ==========================================

  /**
   * 创建下载任务
   */
  async createDownload(videoId, quality) {
    // 检查是否已在队列中
    const existing = this.data.downloads.find(
      dl => dl.videoId === videoId && ['pending', 'downloading'].includes(dl.status)
    );
    if (existing) {
      return existing.id;
    }

    const id = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const download = {
      id,
      videoId,
      status: 'pending',
      quality,
      filePath: null,
      retryCount: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null
    };
    this.data.downloads.push(download);
    await this.save();
    return id;
  }

  /**
   * 获取待下载任务
   */
  async getPendingDownloads(limit) {
    return this.data.downloads
      .filter(dl => dl.status === 'pending')
      .slice(0, limit);
  }

  /**
   * 更新下载状态
   */
  async updateDownloadStatus(id, status, data = {}) {
    const download = this.data.downloads.find(dl => dl.id === id);
    if (download) {
      download.status = status;
      Object.assign(download, data);

      if (status === 'downloading' && !download.startedAt) {
        download.startedAt = new Date().toISOString();
      }
      if (status === 'completed' || status === 'failed') {
        download.completedAt = new Date().toISOString();
      }

      await this.save();
    }
  }

  /**
   * 重试失败的下载
   */
  async retryFailedDownload(id) {
    const download = this.data.downloads.find(dl => dl.id === id);
    if (download && download.retryCount < 2) {
      download.status = 'pending';
      download.retryCount++;
      download.errorMessage = null;
      await this.save();
      return true;
    }
    return false;
  }

  /**
   * 获取下载统计
   */
  async getDownloadStats() {
    const stats = {
      pending: 0,
      downloading: 0,
      completed: 0,
      failed: 0
    };
    this.data.downloads.forEach(dl => {
      if (stats.hasOwnProperty(dl.status)) {
        stats[dl.status]++;
      }
    });
    return stats;
  }

  // ==========================================
  // 清理相关
  // ==========================================

  /**
   * 获取旧的已完成下载
   */
  async getOldDownloads(daysOld) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    return this.data.downloads.filter(dl => {
      if (dl.status !== 'completed' || !dl.completedAt || !dl.filePath) {
        return false;
      }
      const completedDate = new Date(dl.completedAt);
      return completedDate < cutoffDate;
    });
  }
}

module.exports = Storage;
