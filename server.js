require('dotenv').config();  // 加载 .env 文件

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');

// 导入新模块
const config = require('./src/config');
const Storage = require('./src/db');
const MonitoringScheduler = require('./src/scheduler');
const DownloadQueue = require('./src/queue');
const CleanupService = require('./src/cleanup');
const {
  fetchChannelVideosBasic,
  fetchVideoDetails,
  fetchVideosDetailsAsync,
  cancelDetailFetchTask
} = require('./src/utils');
const TelegramService = require('./src/telegram');

// 初始化Express应用
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 内存数据存储
const channels = new Map();   // 存储频道数据
const downloads = new Map();  // 存储下载任务

// 初始化服务实例（稍后启动）
const storage = new Storage(config.database.path);
let scheduler, queueManager, cleanupService, telegramService;

// =============================================
// 核心函数：获取频道视频列表
// =============================================
function fetchChannelVideos(channelUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--skip-download',
      '--ignore-errors',
      '--no-warnings',
      '--playlist-end', '30',  // 只获取最近30个视频（含日期信息，耗时约3-4分钟）
      channelUrl
    ];

    console.log(`正在获取频道视频列表（最近30个，含日期）: ${channelUrl}`);
    const proc = spawn('yt-dlp', args);
    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`获取频道失败: ${errorOutput}`);
        reject(new Error(`获取频道失败: ${channelUrl}`));
        return;
      }

      try {
        // 解析JSON行，提取视频信息
        const lines = output.trim().split('\n').filter(line => line.trim());
        const videos = lines.map(line => {
          const data = JSON.parse(line);
          return {
            id: data.id,
            title: data.title,
            url: `https://youtube.com/watch?v=${data.id}`,
            thumbnail: data.thumbnails && data.thumbnails.length > 0
              ? data.thumbnails[0].url
              : `https://i.ytimg.com/vi/${data.id}/mqdefault.jpg`,
            duration: data.duration || 0,
            upload_date: data.upload_date || null
          };
        });

        console.log(`成功获取 ${videos.length} 个视频`);
        resolve(videos);
      } catch (error) {
        console.error(`解析视频数据失败: ${error.message}`);
        reject(new Error(`解析视频数据失败: ${error.message}`));
      }
    });
  });
}

// =============================================
// 注意：fetchChannelVideosBasic, fetchVideoDetails, fetchVideosDetailsAsync
// 已移至 src/utils.js，通过顶部 require 导入
// =============================================
// 核心函数：下载单个视频
// =============================================
function downloadVideo(id, url, quality, title) {
  const qualityMap = {
    '1080p': 'bestvideo[height<=1080]+bestaudio/best',
    '720p': 'bestvideo[height<=720]+bestaudio/best',
    '480p': 'bestvideo[height<=480]+bestaudio/best'
  };

  const args = [
    '-f', qualityMap[quality] || 'best',
    '--merge-output-format', 'mp4',
    '-o', 'downloads/%(title)s.%(ext)s',
    '--newline',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--extractor-args', 'youtube:player_client=android',
    '--no-check-certificate',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '--referer', 'https://www.youtube.com/',
    url
  ];

  console.log(`开始下载: ${title} [${quality}]`);
  const proc = spawn('yt-dlp', args);

  // 初始化下载任务状态
  downloads.set(id, {
    id,
    videoId: id,
    title,
    url,
    quality,
    status: 'downloading',
    progress: 0,
    speed: ''
  });

  proc.stdout.on('data', (data) => {
    const line = data.toString();

    // 正则匹配进度: [download] 45.8% of 125.50MiB at 5.20MiB/s ETA 00:05:30
    const progressMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
    const speedMatch = line.match(/at\s+(\S+)/);

    if (progressMatch) {
      const progress = parseFloat(progressMatch[1]);
      const speed = speedMatch ? speedMatch[1] : '';

      // 更新内存状态
      const currentTask = downloads.get(id);
      if (currentTask) {
        currentTask.status = 'downloading';
        currentTask.progress = progress;
        currentTask.speed = speed;
        downloads.set(id, currentTask);

        // Socket.io推送进度
        io.emit('download:progress', {
          id,
          title,
          progress,
          speed,
          status: 'downloading'
        });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    console.error(`下载错误 [${title}]: ${data.toString()}`);
  });

  proc.on('close', (code) => {
    const status = code === 0 ? 'completed' : 'failed';
    const currentTask = downloads.get(id);

    if (currentTask) {
      currentTask.status = status;
      currentTask.progress = code === 0 ? 100 : currentTask.progress;
      downloads.set(id, currentTask);

      io.emit('download:progress', {
        id,
        title,
        status,
        progress: code === 0 ? 100 : currentTask.progress,
        speed: code === 0 ? '完成' : '失败'
      });

      console.log(`下载${status === 'completed' ? '完成' : '失败'}: ${title}`);
    }
  });
}

// =============================================
// API端点：获取频道视频列表
// =============================================
app.post('/api/channels/fetch', async (req, res) => {
  const { channelUrls } = req.body;

  if (!channelUrls || !Array.isArray(channelUrls) || channelUrls.length === 0) {
    return res.status(400).json({
      success: false,
      message: '请提供至少一个频道URL'
    });
  }

  console.log(`收到请求：获取 ${channelUrls.length} 个频道的视频（两阶段模式）`);

  try {
    const channelResults = [];

    // 阶段1：快速获取基本信息
    for (const url of channelUrls) {
      try {
        const videos = await fetchChannelVideosBasic(url.trim());
        const channelId = `channel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const channelData = {
          channelId,
          url: url.trim(),
          name: videos.length > 0 ? `频道 (${videos.length}个视频)` : '未知频道',
          videoCount: videos.length,
          videos,
          fetchedAt: new Date(),
          detailsFetchStatus: 'pending'  // 详情获取状态：pending, fetching, completed
        };

        channels.set(channelId, channelData);
        channelResults.push(channelData);
      } catch (error) {
        console.error(`获取频道失败: ${url}`, error);
        // 继续处理其他频道
      }
    }

    // 立即返回阶段1结果
    res.json({
      success: true,
      channels: channelResults,
      totalVideos: channelResults.reduce((sum, ch) => sum + ch.videoCount, 0),
      stage: 1,  // 标识当前阶段
      message: '基本信息已获取，详细信息正在后台加载...'
    });

    // 阶段2：异步获取详细信息（不阻塞响应）
    setImmediate(() => {
      channelResults.forEach(async (channel) => {
        try {
          const channelData = channels.get(channel.channelId);
          if (channelData) {
            channelData.detailsFetchStatus = 'fetching';
            channels.set(channel.channelId, channelData);
          }

          await fetchVideosDetailsAsync(channel.channelId, channel.videos);

          if (channelData) {
            channelData.detailsFetchStatus = 'completed';
            channels.set(channel.channelId, channelData);
          }
        } catch (error) {
          console.error(`阶段2获取失败 [${channel.channelId}]:`, error);
        }
      });
    });

  } catch (error) {
    console.error('获取频道视频列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取视频列表失败: ' + error.message
    });
  }
});

// =============================================
// API端点：取消详情获取任务
// =============================================
app.post('/api/channels/cancel-details', (req, res) => {
  const { taskId } = req.body;

  if (!taskId) {
    return res.status(400).json({
      success: false,
      message: '请提供任务ID'
    });
  }

  const cancelled = cancelDetailFetchTask(taskId);

  res.json({
    success: cancelled,
    message: cancelled ? '任务已取消' : '任务不存在或已完成'
  });
});

// =============================================
// API端点：开始批量下载
// =============================================
app.post('/api/downloads/start', async (req, res) => {
  const { videos, quality } = req.body;

  if (!videos || !Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({
      success: false,
      message: '请至少选择一个视频'
    });
  }

  console.log(`开始批量下载 ${videos.length} 个视频，画质: ${quality}`);

  try {
    // 启动所有下载任务（延迟启动以避免并发过高）
    videos.forEach((video, index) => {
      setTimeout(() => {
        downloadVideo(video.id, video.url, quality, video.title);
      }, index * 1000); // 每个任务延迟1秒启动
    });

    res.json({
      success: true,
      count: videos.length,
      message: `已启动 ${videos.length} 个下载任务`
    });
  } catch (error) {
    console.error('启动下载失败:', error);
    res.status(500).json({
      success: false,
      message: '启动下载失败: ' + error.message
    });
  }
});

// =============================================
// API端点：获取下载列表
// =============================================
app.get('/api/downloads/list', (req, res) => {
  const downloadList = Array.from(downloads.values());
  res.json({
    success: true,
    downloads: downloadList,
    total: downloadList.length
  });
});

// =============================================
// 监控系统 API 端点
// =============================================

// 获取监控状态
app.get('/api/monitor/status', async (req, res) => {
  try {
    const channels = await storage.getChannels();
    const queueStatus = queueManager ? await queueManager.getStatus() : null;
    const schedulerStatus = scheduler ? scheduler.getStatus() : null;
    const cleanupStats = cleanupService ? await cleanupService.getStats() : null;

    res.json({
      success: true,
      monitoring: {
        ...config.monitoring,
        status: schedulerStatus
      },
      queue: queueStatus,
      cleanup: cleanupStats,
      channels
    });
  } catch (error) {
    console.error('获取监控状态失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 添加监控频道
app.post('/api/monitor/channels/add', async (req, res) => {
  try {
    const { url, name } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: '请提供频道URL'
      });
    }

    const channelId = await storage.addChannel(url.trim(), name?.trim());

    res.json({
      success: true,
      channelId,
      message: '频道已添加'
    });
  } catch (error) {
    console.error('添加频道失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 切换频道启用状态
app.post('/api/monitor/channels/toggle', async (req, res) => {
  try {
    const { id, enabled } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: '请提供频道ID'
      });
    }

    await storage.toggleChannel(id, enabled);

    res.json({
      success: true,
      message: `频道已${enabled ? '启用' : '禁用'}`
    });
  } catch (error) {
    console.error('切换频道状态失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 删除频道
app.delete('/api/monitor/channels/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await storage.removeChannel(id);

    res.json({
      success: true,
      message: '频道已删除'
    });
  } catch (error) {
    console.error('删除频道失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 手动立即检查
app.post('/api/monitor/check-now', async (req, res) => {
  try {
    if (!scheduler) {
      return res.status(400).json({
        success: false,
        message: '监控服务未初始化'
      });
    }

    // 异步执行检查，不阻塞响应
    setImmediate(() => {
      scheduler.checkAllChannelsNow();
    });

    res.json({
      success: true,
      message: '正在检查新视频...'
    });
  } catch (error) {
    console.error('手动检查失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 更新监控配置
app.post('/api/monitor/config', async (req, res) => {
  try {
    const { checkInterval, maxConcurrentDownloads, defaultQuality, fileRetentionDays } = req.body;

    if (checkInterval) config.monitoring.checkInterval = checkInterval;
    if (maxConcurrentDownloads) config.monitoring.maxConcurrentDownloads = maxConcurrentDownloads;
    if (defaultQuality) config.monitoring.defaultQuality = defaultQuality;
    if (fileRetentionDays) config.cleanup.fileRetentionDays = fileRetentionDays;

    res.json({
      success: true,
      config: config.monitoring,
      message: '配置已更新（需重启服务生效）'
    });
  } catch (error) {
    console.error('更新配置失败:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =============================================
// 视频列表和下载管理API
// =============================================

// 获取频道的视频列表（含下载状态）
app.get('/api/channels/:channelId/videos', async (req, res) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit) || 5;

    // 获取频道信息
    const channels = await storage.getChannels();
    const channel = channels.find(ch => ch.id === channelId);
    if (!channel) {
      return res.status(404).json({ success: false, message: '频道不存在' });
    }

    // 获取该频道的所有视频（从videos表）
    const allVideos = Object.values(storage.data.videos)
      .filter(v => v.channelId === channelId)
      .sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt))
      .slice(0, limit);

    // 为每个视频附加下载状态
    const videosWithStatus = allVideos.map(video => {
      // 查找最新的下载记录（优先使用startedAt，其次createdAt）
      const downloads = storage.data.downloads
        .filter(dl => dl.videoId === video.id)
        .sort((a, b) => {
          const timeA = new Date(a.startedAt || a.createdAt || 0);
          const timeB = new Date(b.startedAt || b.createdAt || 0);
          return timeB - timeA;
        });

      const latestDownload = downloads[0];

      return {
        ...video,
        downloadStatus: latestDownload ? latestDownload.status : 'not_started',
        downloadId: latestDownload?.id,
        retryCount: latestDownload?.retryCount || 0,
        errorMessage: latestDownload?.errorMessage,
        completedAt: latestDownload?.completedAt
      };
    });

    res.json({
      success: true,
      channel,
      videos: videosWithStatus,
      isFirstCheck: !channel.lastCheckAt  // 标记是否首次检查
    });
  } catch (error) {
    console.error('获取频道视频失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 手动重试下载
app.post('/api/downloads/:downloadId/retry', async (req, res) => {
  try {
    const { downloadId } = req.params;

    const success = await storage.retryFailedDownload(downloadId);

    if (success) {
      res.json({ success: true, message: '已加入重试队列' });
    } else {
      res.json({ success: false, message: '无法重试（已达到最大重试次数）' });
    }
  } catch (error) {
    console.error('重试失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// =============================================
// Socket.io事件处理
// =============================================
io.on('connection', (socket) => {
  console.log('客户端已连接:', socket.id);

  // 发送当前下载列表给新连接的客户端
  const downloadList = Array.from(downloads.values());
  socket.emit('download:list', downloadList);

  // 处理取消详情获取请求
  socket.on('video:details:cancel', (data) => {
    const { taskId } = data;
    const cancelled = cancelDetailFetchTask(taskId);
    socket.emit('video:details:cancelled', { taskId, success: cancelled });
  });

  // 处理断线重连
  socket.on('video:details:reconnect', (data) => {
    const { channelId } = data;
    const channelData = channels.get(channelId);

    if (channelData) {
      socket.emit('video:details:status', {
        channelId,
        status: channelData.detailsFetchStatus,
        videos: channelData.videos
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('客户端已断开:', socket.id);
    // 注意：不取消后台任务，因为其他客户端可能仍在使用
  });
});

// =============================================
// 启动服务器
// =============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`
===========================================
  YouTube频道批量下载器 - 自动监控版
===========================================
  服务器运行在: http://localhost:${PORT}
  `);

  try {
    // 初始化存储层
    await storage.init();
    console.log('✅ 存储层已初始化');

    // 初始化 Telegram 服务
    telegramService = new TelegramService(config.telegram);
    await telegramService.init();
    if (config.telegram.enabled) {
      console.log('✅ Telegram 通知服务已启动');
    } else {
      console.log('ℹ️  Telegram 通知服务已禁用');
    }

    // 初始化下载队列
    queueManager = new DownloadQueue(storage, config.monitoring, io, telegramService);
    await queueManager.start();
    console.log('✅ 下载队列已启动');

    // 初始化监控调度器
    scheduler = new MonitoringScheduler(storage, queueManager, config.monitoring, io);
    if (config.monitoring.enabled) {
      scheduler.start();
      console.log('✅ 监控调度器已启动');
    } else {
      console.log('ℹ️  监控调度器已禁用（可通过配置启用）');
    }

    // 初始化清理服务
    cleanupService = new CleanupService(storage, config.cleanup);
    cleanupService.start();
    console.log('✅ 文件清理服务已启动');

    console.log(`
===========================================
  请在浏览器中打开上述地址开始使用
===========================================
  `);

  } catch (error) {
    console.error('❌ 服务初始化失败:', error);
    process.exit(1);
  }
});

// =============================================
// 优雅关闭处理
// =============================================
process.on('SIGINT', async () => {
  console.log('\n⚠️  正在关闭服务...');

  try {
    // 停止调度器
    if (scheduler) {
      scheduler.stop();
      console.log('✓ 调度器已停止');
    }

    // 停止清理服务
    if (cleanupService) {
      cleanupService.stop();
      console.log('✓ 清理服务已停止');
    }

    // 停止队列（等待活跃下载完成）
    if (queueManager) {
      await queueManager.stop();
      console.log('✓ 下载队列已停止');
    }

    // 停止 Telegram 服务
    if (telegramService) {
      telegramService.stop();
      console.log('✓ Telegram 服务已停止');
    }

    // 最后保存一次存储
    if (storage) {
      await storage.save();
      console.log('✓ 数据已保存');
    }

    // 关闭服务器
    server.close(() => {
      console.log('✅ 服务器已关闭\n');
      process.exit(0);
    });

    // 10秒后强制退出
    setTimeout(() => {
      console.error('⚠️  强制退出');
      process.exit(1);
    }, 10000);

  } catch (error) {
    console.error('❌ 关闭失败:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  收到SIGTERM信号，正在关闭...');
  process.emit('SIGINT');
});
