// YouTube下载器监控系统配置

module.exports = {
  // 监控配置
  monitoring: {
    enabled: true,                     // 全局监控开关
    checkInterval: 5 * 60 * 1000,     // 检查间隔：5分钟
    latestVideosCount: 3,             // 每频道检查最新N个视频
    maxConcurrentDownloads: 3,        // 最大并发下载数
    defaultQuality: '720p',           // 默认下载画质
    fileRetentionDays: 5              // 文件保留天数
  },

  // 数据库配置
  database: {
    path: './data/storage.json'       // JSON存储文件路径
  },

  // 下载配置
  downloads: {
    outputPath: './downloads'         // 下载文件保存路径
  },

  // 清理配置
  cleanup: {
    enabled: true,                    // 启用自动清理
    checkInterval: 24 * 60 * 60 * 1000  // 清理间隔：每天
  },

  // Telegram 通知配置
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true' || false,
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',

    notifications: {
      onComplete: true,          // 下载成功通知
      onFailure: false,          // 下载失败通知（默认关闭）
      includeChannelName: true,  // 包含频道名称
    },

    retry: {
      maxAttempts: 3,            // 最大重试次数
      delayMs: 2000,             // 重试延迟（毫秒）
    },

    messageFormat: 'Markdown'    // 消息格式
  }
};
