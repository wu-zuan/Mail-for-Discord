const { WebhookClient } = require('discord.js');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

/**
 * 透過 Discord Webhook 直接推送通知到指定頻道。
 * 不需要 Bot Token，但 Webhook 訊息無法附帶互動按鈕 (例如「標記已讀」)。
 */
class WebhookService {
    constructor(config) {
        this.config = config;
        this.logger = new Logger('Webhook');
        this.client = new WebhookClient({ url: config.webhookUrl });
        this.isReady = false;
    }

    async init() {
        try {
            // GET /webhooks/{id}/{token} 不需要 Bot 權限，可用來驗證 Webhook 是否存在
            const res = await fetch(this.config.webhookUrl, { method: 'GET' });
            if (!res.ok) {
                throw new Error(`Webhook 驗證失敗 (HTTP ${res.status})，請確認 DISCORD_WEBHOOK_URL 是否正確或已被刪除`);
            }
            const info = await res.json();
            this.isReady = true;
            this.logger.info(`Webhook 已就緒: ${info.name || '(未命名)'} (頻道 ID: ${info.channel_id})`);
        } catch (error) {
            this.logger.error('Webhook 初始化失敗', error);
            throw error;
        }
    }

    async sendEmail(emailData) {
        if (!this.isReady) {
            this.logger.warn('Webhook 尚未就緒，無法發送訊息');
            return;
        }
        try {
            const messageOptions = Formatter.createWebhookEmailMessage(emailData);
            await this.client.send(messageOptions);
            this.logger.info(`已透過 Webhook 發送通知 (ID: ${emailData.id})`);
        } catch (error) {
            this.logger.error('Webhook 發送失敗', error);
            throw error;
        }
    }

    async sendText(content) {
        if (!this.isReady) {
            this.logger.warn('Webhook 尚未就緒，無法發送訊息');
            return;
        }
        try {
            await this.client.send({ content });
        } catch (error) {
            this.logger.error('Webhook 發送文字訊息失敗', error);
            throw error;
        }
    }

    destroy() {
        this.client.destroy();
        this.isReady = false;
    }
}

module.exports = WebhookService;
