const Logger = require('../utils/logger');

/**
 * 統一的通知分派器。
 * 依照 NOTIFY_MODE 把郵件通知同時送往 Discord Bot 私訊和 / 或 Webhook，
 * 並回報每個管道各自的成功 / 失敗狀態，讓重試只補發失敗的管道。
 */
class NotifierService {
    constructor({ discordService = null, webhookService = null, targetUserId = null }) {
        this.logger = new Logger('Notifier');
        this.discordService = discordService;
        this.webhookService = webhookService;
        this.targetUserId = targetUserId;

        this.channels = [];
        if (this.discordService) {
            this.channels.push({
                name: 'bot',
                sendEmail: (data) => this.discordService.sendDM(this.targetUserId, data),
                sendText: (text) => this.discordService.sendText(this.targetUserId, text)
            });
        }
        if (this.webhookService) {
            this.channels.push({
                name: 'webhook',
                sendEmail: (data) => this.webhookService.sendEmail(data),
                sendText: (text) => this.webhookService.sendText(text)
            });
        }
        if (this.channels.length === 0) {
            throw new Error('NotifierService 至少需要一個通知管道 (Bot 或 Webhook)');
        }
    }

    get channelNames() {
        return this.channels.map(c => c.name);
    }

    /**
     * 發送郵件通知。
     * @param {object} emailData
     * @param {{ only?: string[] }} options 只發送給指定名稱的管道 (用於重試)
     * @returns {Promise<{ succeeded: string[], failed: string[] }>}
     */
    async sendEmail(emailData, { only = null } = {}) {
        const targets = only ? this.channels.filter(c => only.includes(c.name)) : this.channels;
        const succeeded = [];
        const failed = [];

        await Promise.all(targets.map(async (channel) => {
            try {
                await channel.sendEmail(emailData);
                succeeded.push(channel.name);
            } catch (error) {
                this.logger.error(`[${channel.name}] 發送郵件通知失敗 (ID: ${emailData.id})`);
                failed.push(channel.name);
            }
        }));

        return { succeeded, failed };
    }

    /**
     * 發送純文字訊息 (例如系統警告)，盡力送達所有管道，不丟出錯誤。
     */
    async broadcastText(text) {
        await Promise.all(this.channels.map(async (channel) => {
            try {
                await channel.sendText(text);
            } catch (error) {
                this.logger.error(`[${channel.name}] 發送文字訊息失敗`, error);
            }
        }));
    }
}

module.exports = NotifierService;
