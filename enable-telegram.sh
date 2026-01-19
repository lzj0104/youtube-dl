#!/bin/bash

echo "=========================================="
echo "  Telegram 通知配置助手"
echo "=========================================="
echo ""

# 读取当前配置
CURRENT_ENV="/Users/wangboyi/lzjclaude/youtube-dl/.env"

echo "请输入 Telegram Bot Token:"
read -r BOT_TOKEN

echo "请输入 Telegram Chat ID:"
read -r CHAT_ID

if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
    echo "❌ Bot Token 和 Chat ID 不能为空！"
    exit 1
fi

# 更新 .env 文件
cat > "$CURRENT_ENV" << EOF
# Telegram 通知配置
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
TELEGRAM_CHAT_ID=$CHAT_ID
EOF

echo ""
echo "✅ 配置已保存到 .env 文件"
echo ""
echo "正在重启服务..."
pm2 restart youtube-dl-monitor

echo ""
echo "查看启动日志 (Ctrl+C 退出):"
sleep 3
pm2 logs youtube-dl-monitor --lines 20

