const Logger = require('../utils/logger');

const VALID_MODES = ['bot', 'webhook', 'both'];

class ConfigLoader {
    constructor() {
        this.logger = new Logger('ConfigLoader');
        this.config = null;
    }

    async load() {
        try {
            const token = process.env.DISCORD_TOKEN?.trim() || null;
            const targetUserId = process.env.DISCORD_TARGET_USER_ID?.trim() || null;
            const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim() || null;
            const mode = this._resolveMode(process.env.NOTIFY_MODE, { token, webhookUrl });

            this.config = {
                notify: {
                    mode,
                    useBot: mode === 'bot' || mode === 'both',
                    useWebhook: mode === 'webhook' || mode === 'both'
                },
                discord: {
                    token,
                    targetUserId,
                    webhookUrl
                },
                gmail: {
                    pollingIntervalMinutes: parseInt(process.env.GMAIL_POLLING_INTERVAL_MINUTES || '1', 10)
                }
            };
            this.validate();
            this.logger.info(`環境變數設定載入成功 (通知模式: ${mode})`);
            return this.config;
        } catch (error) {
            this.logger.error('環境變數設定載入失敗', error);
            throw error;
        }
    }

    /**
     * 決定通知模式：
     * - 有明確設定 NOTIFY_MODE 就以它為準 (bot / webhook / both)
     * - 沒設定時依照填寫了哪些變數自動判斷
     */
    _resolveMode(rawMode, { token, webhookUrl }) {
        const normalized = rawMode?.trim().toLowerCase();
        if (normalized) {
            if (!VALID_MODES.includes(normalized)) {
                throw new Error(`NOTIFY_MODE 的值無效: "${rawMode}"，可用值為 ${VALID_MODES.join(' / ')}`);
            }
            return normalized;
        }
        if (token && webhookUrl) return 'both';
        if (webhookUrl) return 'webhook';
        return 'bot';
    }

    validate() {
        const missing = [];
        const { notify, discord } = this.config;

        if (notify.useBot) {
            if (!discord.token) missing.push('DISCORD_TOKEN');
            if (!discord.targetUserId) missing.push('DISCORD_TARGET_USER_ID');
        }
        if (notify.useWebhook) {
            if (!discord.webhookUrl) {
                missing.push('DISCORD_WEBHOOK_URL');
            } else if (!/^https?:\/\/(?:ptb\.|canary\.)?discord\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{17,19}\/[\w-]{68}$/i.test(discord.webhookUrl)) {
                // 與 discord.js WebhookClient 的驗證規則一致，提早在設定階段給出清楚的錯誤
                throw new Error('DISCORD_WEBHOOK_URL 格式不正確，應為 https://discord.com/api/webhooks/<id>/<token> (請完整複製頻道設定中的 Webhook 網址)');
            }
        }
        if (missing.length > 0) {
            throw new Error(`環境變數缺少必要欄位 (通知模式: ${notify.mode}): ${missing.join(', ')}`);
        }
        if (!Number.isFinite(this.config.gmail.pollingIntervalMinutes) || this.config.gmail.pollingIntervalMinutes <= 0) {
            throw new Error('GMAIL_POLLING_INTERVAL_MINUTES 必須為大於 0 的數字');
        }
    }

    get() {
        if (!this.config) throw new Error('設定檔尚未載入');
        return this.config;
    }
}

module.exports = new ConfigLoader();
