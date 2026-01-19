const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

/**
 * 文件清理服务
 * 定期删除旧的下载文件，保留去重记录
 */
class CleanupService {
  constructor(storage, config) {
    this.storage = storage;
    this.config = config;
    this.cronTask = null;
  }

  /**
   * 启动定时清理任务
   */
  start() {
    if (!this.config.enabled) {
      console.log('ℹ️  文件清理服务已禁用');
      return;
    }

    if (this.cronTask) {
      console.log('⚠️  清理服务已在运行');
      return;
    }

    console.log(`✅ 启动文件清理服务 (间隔: 每天)`);

    // 每天凌晨3点执行清理
    // cron格式: 分 时 日 月 周
    this.cronTask = cron.schedule('0 3 * * *', async () => {
      console.log('\n🧹 开始定时清理...');
      await this.cleanupNow();
    });

    // 启动后延迟1分钟执行一次清理
    setTimeout(() => {
      this.cleanupNow();
    }, 60000);
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      console.log('🛑 清理服务已停止');
    }
  }

  /**
   * 手动立即清理
   */
  async cleanupNow() {
    try {
      const retentionDays = this.config.fileRetentionDays || 5;
      console.log(`🔍 查找 ${retentionDays} 天前的下载文件...`);

      // 获取旧的已完成下载
      const oldDownloads = await this.storage.getOldDownloads(retentionDays);

      if (oldDownloads.length === 0) {
        console.log('✓ 没有需要清理的文件\n');
        return;
      }

      console.log(`📁 找到 ${oldDownloads.length} 个旧文件，开始清理...`);

      let deletedCount = 0;
      let errorCount = 0;
      let totalSize = 0;

      for (const download of oldDownloads) {
        try {
          const deleted = await this._deleteDownloadFiles(download);
          if (deleted.success) {
            deletedCount++;
            totalSize += deleted.size;

            // 更新存储: 保留记录但清除文件路径
            await this.storage.updateDownloadStatus(download.id, 'completed', {
              filePath: null
            });

            console.log(`   ✓ 已删除: ${path.basename(download.filePath)}`);
          } else {
            errorCount++;
          }
        } catch (error) {
          errorCount++;
          console.error(`   ✗ 删除失败 [${download.id}]: ${error.message}`);
        }
      }

      const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
      console.log(`\n✅ 清理完成: ${deletedCount} 个文件已删除, ${errorCount} 个失败, 释放空间: ${sizeMB} MB\n`);

    } catch (error) {
      console.error('❌ 清理失败:', error);
    }
  }

  /**
   * 删除单个下载的相关文件
   * @param {Object} download - 下载记录
   * @returns {Object} - { success: boolean, size: number }
   */
  async _deleteDownloadFiles(download) {
    if (!download.filePath) {
      return { success: false, size: 0 };
    }

    let totalSize = 0;
    let deletedAny = false;

    // 1. 删除视频文件 (.mp4)
    if (fs.existsSync(download.filePath)) {
      try {
        const stats = fs.statSync(download.filePath);
        totalSize += stats.size;

        fs.unlinkSync(download.filePath);
        deletedAny = true;
      } catch (error) {
        console.error(`   ⚠️  删除视频失败: ${error.message}`);
      }
    }

    // 2. 删除缩略图 (.jpg)
    const thumbnailPath = this._getThumbnailPath(download.filePath);
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        const stats = fs.statSync(thumbnailPath);
        totalSize += stats.size;

        fs.unlinkSync(thumbnailPath);
        deletedAny = true;
      } catch (error) {
        console.error(`   ⚠️  删除缩略图失败: ${error.message}`);
      }
    }

    // 3. 删除其他可能的缩略图格式 (.webp, .png)
    for (const ext of ['.webp', '.png']) {
      const altThumbnail = download.filePath.replace(/\.mp4$/, ext);
      if (fs.existsSync(altThumbnail)) {
        try {
          const stats = fs.statSync(altThumbnail);
          totalSize += stats.size;

          fs.unlinkSync(altThumbnail);
        } catch (error) {
          // 静默忽略
        }
      }
    }

    return {
      success: deletedAny,
      size: totalSize
    };
  }

  /**
   * 获取缩略图路径
   */
  _getThumbnailPath(videoPath) {
    if (!videoPath) return null;

    // yt-dlp生成的缩略图格式: video.jpg (与video.mp4同名)
    return videoPath.replace(/\.mp4$/, '.jpg');
  }

  /**
   * 获取清理统计
   */
  async getStats() {
    const retentionDays = this.config.fileRetentionDays || 5;
    const oldDownloads = await this.storage.getOldDownloads(retentionDays);

    let totalSize = 0;
    let fileCount = 0;

    for (const download of oldDownloads) {
      if (download.filePath && fs.existsSync(download.filePath)) {
        try {
          const stats = fs.statSync(download.filePath);
          totalSize += stats.size;
          fileCount++;
        } catch (error) {
          // 忽略
        }
      }
    }

    return {
      enabled: this.config.enabled,
      retentionDays,
      oldFileCount: fileCount,
      estimatedSize: totalSize,
      estimatedSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
  }
}

module.exports = CleanupService;
