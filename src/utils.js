const { spawn } = require('child_process');

// 存储活跃的详情获取任务
const activeDetailFetchTasks = new Map();

/**
 * 快速获取频道视频基本信息（使用--flat-playlist）
 * @param {string} channelUrl - 频道URL
 * @param {number} limit - 获取视频数量限制
 * @returns {Promise<Array>} - 视频列表
 */
function fetchChannelVideosBasic(channelUrl, limit = 30) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist',      // 快速模式：仅获取基本信息
      '--dump-json',
      '--skip-download',
      '--ignore-errors',
      '--no-warnings',
      '--playlist-end', String(limit),
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

/**
 * 获取单个视频的详细信息（日期、时长）
 * @param {string} videoId - 视频ID
 * @param {string} videoUrl - 视频URL
 * @returns {Promise<Object>} - 视频详情
 */
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

/**
 * 批量异步获取视频详细信息
 * @param {string} channelId - 频道ID
 * @param {Array} videos - 视频列表
 * @param {Object} io - Socket.io实例
 * @returns {Promise<void>}
 */
async function fetchVideosDetailsAsync(channelId, videos, io) {
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
  if (io) {
    io.emit('video:details:start', {
      channelId,
      taskId,
      total: videos.length
    });
  }

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
      if (io) {
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
      }

      console.log(`[阶段2] 进度: ${completed + failed}/${videos.length} (成功: ${completed}, 失败: ${failed})`);

    } catch (error) {
      failed++;
      console.error(`[阶段2] 获取详情失败 [${video.id}]: ${error.message}`);

      // 推送失败通知
      if (io) {
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
  if (io) {
    io.emit('video:details:complete', {
      channelId,
      taskId,
      total: videos.length,
      completed,
      failed
    });
  }

  console.log(`[阶段2] 完成！总数: ${videos.length}, 成功: ${completed}, 失败: ${failed}`);

  // 清理任务记录
  activeDetailFetchTasks.delete(taskId);
}

/**
 * 取消详情获取任务
 * @param {string} taskId - 任务ID
 * @returns {boolean} - 是否成功取消
 */
function cancelDetailFetchTask(taskId) {
  const task = activeDetailFetchTasks.get(taskId);
  if (task) {
    task.cancelled = true;
    console.log(`[阶段2] 取消任务: ${taskId}`);
    return true;
  }
  return false;
}

module.exports = {
  fetchChannelVideosBasic,
  fetchVideoDetails,
  fetchVideosDetailsAsync,
  cancelDetailFetchTask,
  activeDetailFetchTasks
};
