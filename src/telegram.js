const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

/**
 * Telegram 通知服务
 * 处理下载完成后的消息推送
 */
class TelegramService {
  constructor(config) {
    this.enabled = config.enabled;
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.messageFormat = config.messageFormat || 'Markdown';

    this.onComplete = config.notifications?.onComplete !== false;
    this.onFailure = config.notifications?.onFailure || false;
    this.includeChannelName = config.notifications?.includeChannelName !== false;

    this.maxRetries = config.retry?.maxAttempts || 3;
    this.retryDelay = config.retry?.delayMs || 2000;

    this.bot = null;
  }

  /**
   * 初始化 Bot
   */
  async init() {
    if (!this.enabled) {
      return;
    }

    if (!this.botToken || !this.chatId) {
      console.warn('[Telegram] 配置不完整，服务将跳过通知');
      this.enabled = false;
      return;
    }

    try {
      this.bot = new TelegramBot(this.botToken, { polling: false });
      const me = await this.bot.getMe();
      console.log(`[Telegram] Bot 已连接: @${me.username}`);
    } catch (error) {
      console.error('[Telegram] 初始化失败:', error.message);
      this.enabled = false;
    }
  }

  /**
   * 发送下载完成通知
   */
  async notifyDownloadComplete(video, channel, filePath) {
    if (!this.enabled || !this.onComplete) {
      return { success: false, reason: 'disabled' };
    }

    const message = this._formatSuccessMessage(video, channel, filePath);

    return await this.sendMessage(message, {
      parse_mode: this.messageFormat,
      disable_web_page_preview: true
    });
  }

  /**
   * 发送消息（含重试逻辑）
   */
  async sendMessage(text, options = {}) {
    if (!this.enabled) {
      return { success: false, reason: 'disabled' };
    }

    // 重试逻辑
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.bot.sendMessage(this.chatId, text, options);
        return { success: true };

      } catch (error) {
        const isLastAttempt = attempt === this.maxRetries;

        if (this._isRetryableError(error) && !isLastAttempt) {
          const delay = this.retryDelay * attempt;
          console.warn(`[Telegram] 重试 ${attempt}/${this.maxRetries}: ${error.message}`);
          await this._sleep(delay);
          continue;
        }

        console.error(`[Telegram] 发送失败: ${error.message}`);
        return { success: false, reason: 'send_failed', error: error.message };
      }
    }
  }

  /**
   * 格式化成功消息
   */
  _formatSuccessMessage(video, channel, filePath) {
    const fileName = path.basename(filePath);
    const timestamp = new Date().toLocaleString('zh-CN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    let message = `✅ *下载完成*\n\n`;
    message += `📺 *视频*: ${this._escapeMarkdown(video.title)}\n`;

    if (this.includeChannelName && channel?.name) {
      message += `📁 *频道*: ${this._escapeMarkdown(channel.name)}\n`;
    }

    message += `🗂️ *路径*: \`${fileName}\`\n`;
    message += `⏱️ *时间*: ${timestamp}`;

    return message;
  }

  /**
   * Markdown 特殊字符转义
   */
  _escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }

  /**
   * 判断是否为可重试的错误
   */
  _isRetryableError(error) {
    const retryableCodes = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'];
    const retryableMessages = ['Too Many Requests', 'network', 'timeout'];

    return retryableCodes.includes(error.code) ||
           retryableMessages.some(msg =>
             error.message.toLowerCase().includes(msg.toLowerCase())
           );
  }

  /**
   * 延迟工具
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 停止服务
   */
  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
  }
}

module.exports = TelegramService;
