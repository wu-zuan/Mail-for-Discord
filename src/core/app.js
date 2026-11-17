const fs = require('fs');
const path = require('path');
const configLoader = require('../config/config.loader');
const authService = require('../services/auth.service');
const StorageService = require('../services/storage.service');
const GmailService = require('../services/gmail.service');
const DiscordService = require('../services/discord.service');
const WebhookService = require('../services/webhook.service');
const NotifierService = require('../services/notifier.service');
const Logger = require('../utils/logger');

class GmailNotifierApp {
    constructor() {
        this.logger = new Logger('App');
        this.isRunning = false;
        this.discordService = null;
        this.webhookService = null;
        this.notifier = null;
    }

    async bootstrap() {
        try {
            this.logger.info('正在啟動應用程式...');
            const config = await configLoader.load();
            this.config = config;
            this.storage = new StorageService();
            await this.storage.init();

            if (config.notify.useBot) {
                this.discordService = new DiscordService(config.discord);
                await this.discordService.init();
            }
            if (config.notify.useWebhook) {
                this.webhookService = new WebhookService(config.discord);
                await this.webhookService.init();
            }

            this.notifier = new NotifierService({
                discordService: this.discordService,
                webhookService: this.webhookService,
                targetUserId: config.discord.targetUserId
            });
            this.logger.info(`通知管道: ${this.notifier.channelNames.join(' + ')}`);

            const authClient = await authService.getClient(this.discordService, config.discord.targetUserId, this.storage);
            this.gmailService = new GmailService(authClient);

            if (this.discordService) {
                this.discordService.onMarkAsRead = async (id) => {
                    await this.gmailService.markAsRead(id);
                    this.logger.info(`使用者透過 Discord 標記已讀: ${id}`);
                };
            }
            this.logger.info('所有服務初始化完成');
            this.startPolling();
        } catch (error) {
            this.logger.error('應用程式啟動失敗', error);
            process.exit(1);
        }
    }

    startPolling() {
        this.isRunning = true;
        const intervalMinutes = this.config.gmail.pollingIntervalMinutes || 1;
        this._updatePresence(`信箱 (${intervalMinutes}m/次)`, 'online');
        this.logger.info(`開始監測任務，頻率: 每 ${intervalMinutes} 分鐘`);
        this.runTask();
        setInterval(() => this.runTask(), intervalMinutes * 60 * 1000);
    }

    _updatePresence(text, status) {
        if (this.discordService) {
            this.discordService.updatePresence(text, status);
        }
    }

    _loadBlacklist() {
        const blacklistPath = path.join(__dirname, '../../blacklist.txt');
        if (!fs.existsSync(blacklistPath)) return [];
        try {
            return fs.readFileSync(blacklistPath, 'utf8')
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch (err) {
            this.logger.error('讀取過濾黑名單失敗', err);
            return [];
        }
    }

    /**
     * 發送通知；若有管道失敗，3 分鐘後只對失敗的管道重試一次。
     * 郵件 ID 會在「所有管道都成功」或「重試結束」後才寫入已處理紀錄，
     * 避免 both 模式下某一邊成功、另一邊永遠收不到。
     */
    async _notify(msgId, details) {
        const { failed } = await this.notifier.sendEmail(details);
        if (failed.length === 0) {
            await this.storage.add(msgId);
            return;
        }

        this.logger.error(`發送通知失敗 (ID: ${msgId}，失敗管道: ${failed.join(', ')})，將在 3 分鐘後重試...`);
        setTimeout(async () => {
            this.logger.info(`🔄 開始重試發送 (ID: ${msgId}，管道: ${failed.join(', ')})`);
            const retry = await this.notifier.sendEmail(details, { only: failed });
            if (retry.failed.length === 0) {
                this.logger.info(`✅ 成功重發通知 (ID: ${msgId})`);
            } else {
                this.logger.error(`❌ 重發通知依然失敗 (ID: ${msgId}，管道: ${retry.failed.join(', ')})，放棄此封郵件`);
            }
            await this.storage.add(msgId);
        }, 3 * 60 * 1000);
    }

    async runTask() {
        try {
            const messages = await this.gmailService.getUnreadMessages();
            if (messages.length === 0) {
                return;
            }
            const newMessages = [];
            for (const msg of messages) {
                const hasBeenProcessed = await this.storage.has(msg.id);
                if (!hasBeenProcessed) {
                    newMessages.push(msg);
                }
            }
            if (newMessages.length === 0) {
                return;
            }
            const blacklist = this._loadBlacklist();

            this.logger.info(`發現 ${newMessages.length} 封新未讀郵件`);
            for (const msg of newMessages) {
                const details = await this.gmailService.getMessageDetails(msg.id);

                const matchedRule = blacklist.find(rule => details.subject.includes(rule));
                if (matchedRule) {
                    this.logger.info(`[過濾] 郵件標題匹配黑名單規則: "${matchedRule}"，已標記為已處理並略過發送至 Discord。標題: "${details.subject}"`);
                    await this.storage.add(msg.id);
                    continue;
                }

                await this._notify(msg.id, details);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (error) {
            this.logger.error('執行監測任務時發生錯誤', error);

            const isInvalidGrant = error.response?.data?.error === 'invalid_grant' || String(error).includes('invalid_grant');
            if (isInvalidGrant) {
                this.logger.error('Token 已失效 (invalid_grant)！正在清除無效的授權記錄並中斷服務以重新授權。');

                await this.notifier.broadcastText('⚠️ **[Gmail 監測服務警告]**\n您的 Google 授權 Token 已經失效 (通常是因為您的 Google Cloud 專案仍在「測試階段」，導致 Token 每 7 天過期一次)。\n\n**系統已自動清除無效的 Token 並停止目前的監測。**\n請**重新啟動機器人**，系統將會引導您重新進行認證綁定！\n\n💡 *解決「憑證很容易過期」的根本方法：請至 Google Cloud Console -> [API和服務] -> [OAuth 同意畫面] -> 點擊「發布應用程式 (Publish App)」，將發布狀態改為「實際運作 (In production)」。*');

                if (this.storage) {
                    await this.storage.deleteSetting('user_tokens');
                }

                process.exit(1);
            }
        }
    }
}

module.exports = GmailNotifierApp;
