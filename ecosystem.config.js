module.exports = {
  apps: [{
    name: 'youtube-dl-monitor',
    script: './server.js',

    // 自动重启配置
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,

    // 环境变量
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },

    env_development: {
      NODE_ENV: 'development',
      PORT: 3000
    },

    // 日志配置
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,

    // 优雅关闭
    kill_timeout: 10000,
    wait_ready: false,
    listen_timeout: 10000,

    // 实例数（单实例，避免数据冲突）
    instances: 1,
    exec_mode: 'fork',

    // 忽略监控的文件
    ignore_watch: [
      'node_modules',
      'logs',
      'downloads',
      'data',
      'public'
    ],

    // 时区
    time: true
  }]
};
