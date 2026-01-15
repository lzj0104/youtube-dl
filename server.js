const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');

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
// 阶段1：快速获取基本视频信息（使用 --flat-playlist）
// =============================================
function fetchChannelVideosBasic(channelUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',      // 快速模式：仅获取基本信息
      '--dump-json',
      '--skip-download',
      '--ignore-errors',
      '--no-warnings',
      '--playlist-end', '30',
      channelUrl
    ];

    console.log(`[阶段1] 快速获取频道基本信息: ${channelUrl}`);
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
        const lines = output.trim().split('\n').filter(line => line.trim());
        const videos = lines.map(line => {
          const data = JSON.parse(line);
          return {
            id: data.id,
            title: data.title || data.url || '未知标题',
            url: `https://youtube.com/watch?v=${data.id}`,
            thumbnail: data.thumbnails && data.thumbnails.length > 0
              ? data.thumbnails[0].url
              : `https://i.ytimg.com/vi/${data.id}/mqdefault.jpg`,
            duration: null,           // 阶段1不包含时长
            upload_date: null,        // 阶段1不包含日期
            detailsLoading: true      // 标记：详细信息加载中
          };
        });

        console.log(`[阶段1] 成功获取 ${videos.length} 个视频的基本信息`);
        resolve(videos);
      } catch (error) {
        console.error(`解析视频数据失败: ${error.message}`);
        reject(new Error(`解析视频数据失败: ${error.message}`));
      }
    });
  });
}

// =============================================
// 阶段2：获取单个视频的详细信息（日期、时长）
// =============================================
function fetchVideoDetails(videoId, videoUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--skip-download',
      '--no-warnings',
      videoUrl
    ];

    console.log(`[阶段2] 获取视频详细信息: ${videoId}`);
    const proc = spawn('yt-dlp', args);
    let output = '';
    let errorOutput = '';

    // 设置超时：单个视频最多60秒
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('获取详细信息超时'));
    }, 60000);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        console.error(`获取视频详情失败 [${videoId}]: ${errorOutput}`);
        reject(new Error(`获取视频详情失败: ${videoId}`));
        return;
      }

      try {
        const data = JSON.parse(output.trim());
        resolve({
          id: videoId,
          duration: data.duration || 0,
          upload_date: data.upload_date || null
        });
      } catch (error) {
        console.error(`解析视频详情失败 [${videoId}]: ${error.message}`);
        reject(error);
      }
    });
  });
}

// =============================================
// 阶段2控制器：批量异步获取详细信息
// =============================================
const activeDetailFetchTasks = new Map(); // 存储活跃的详情获取任务

async function fetchVideosDetailsAsync(channelId, videos, socketId = null) {
  const taskId = `details_${channelId}_${Date.now()}`;

  console.log(`[阶段2] 开始异步获取 ${videos.length} 个视频的详细信息`);

  // 记录任务
  activeDetailFetchTasks.set(taskId, {
    channelId,
    total: videos.length,
    completed: 0,
    failed: 0,
    cancelled: false
  });

  // 并发控制：同时最多3个请求
  const CONCURRENT_LIMIT = 3;
  let index = 0;
  let completed = 0;
  let failed = 0;

  // 通知开始
  io.emit('video:details:start', {
    channelId,
    taskId,
    total: videos.length
  });

  // 并发处理函数
  const processNext = async () => {
    if (index >= videos.length) return;

    const task = activeDetailFetchTasks.get(taskId);
    if (task && task.cancelled) {
      console.log(`[阶段2] 任务已取消: ${taskId}`);
      return;
    }

    const currentIndex = index++;
    const video = videos[currentIndex];

    try {
      const details = await fetchVideoDetails(video.id, video.url);

      completed++;

      // 实时推送更新
      io.emit('video:details:update', {
        channelId,
        taskId,
        videoId: video.id,
        details: {
          duration: details.duration,
          upload_date: details.upload_date
        },
        progress: {
          current: completed + failed,
          total: videos.length,
          completed,
          failed
        }
      });

      console.log(`[阶段2] 进度: ${completed + failed}/${videos.length} (成功: ${completed}, 失败: ${failed})`);

    } catch (error) {
      failed++;
      console.error(`[阶段2] 获取详情失败 [${video.id}]: ${error.message}`);

      // 推送失败通知
      io.emit('video:details:update', {
        channelId,
        taskId,
        videoId: video.id,
        error: true,
        progress: {
          current: completed + failed,
          total: videos.length,
          completed,
          failed
        }
      });
    }

    // 继续处理下一个
    if (index < videos.length) {
      await processNext();
    }
  };

  // 启动并发任务
  const workers = [];
  for (let i = 0; i < CONCURRENT_LIMIT; i++) {
    workers.push(processNext());
  }

  await Promise.all(workers);

  // 完成通知
  io.emit('video:details:complete', {
    channelId,
    taskId,
    total: videos.length,
    completed,
    failed
  });

  console.log(`[阶段2] 完成！总数: ${videos.length}, 成功: ${completed}, 失败: ${failed}`);

  // 清理任务记录
  activeDetailFetchTasks.delete(taskId);
}

// 取消详情获取任务
function cancelDetailFetchTask(taskId) {
  const task = activeDetailFetchTasks.get(taskId);
  if (task) {
    task.cancelled = true;
    console.log(`[阶段2] 取消任务: ${taskId}`);
    return true;
  }
  return false;
}

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

server.listen(PORT, () => {
  console.log(`
===========================================
  YouTube频道批量下载器
===========================================
  服务器运行在: http://localhost:${PORT}

  请在浏览器中打开上述地址开始使用
===========================================
  `);
});
