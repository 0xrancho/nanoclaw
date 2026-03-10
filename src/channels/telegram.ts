import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private pollingMonitor: ReturnType<typeof setInterval> | null = null;
  private lastUpdateAt = Date.now();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Auto-retry all API calls on transient network errors.
    // This covers sendMessage, getUpdates, sendChatAction, etc.
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      const MAX_ATTEMPTS = 5;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await prev(method, payload, signal);
        } catch (err: any) {
          const errCode = err?.error?.code || err?.error?.errno || '';
          const isNetwork = errCode === 'ETIMEDOUT' ||
            errCode === 'ECONNRESET' ||
            errCode === 'ECONNREFUSED' ||
            (err?.message || '').includes('Network request');
          if (isNetwork && attempt < MAX_ATTEMPTS) {
            const delay = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s, 24s
            logger.warn({ method, attempt, delay }, 'Telegram API network error, retrying');
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }
      throw new Error('unreachable');
    });

    this.setupHandlers();

    // Start polling with watchdog
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          this.startPollingWatchdog();
          resolve();
        },
      });
    });
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      this.lastUpdateAt = Date.now();

      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Extract reply-to context so the agent sees what's being replied to
      const reply = ctx.message.reply_to_message;
      if (reply) {
        const replyFrom =
          reply.from?.first_name || reply.from?.username || 'Unknown';
        const replyText =
          'text' in reply && reply.text
            ? reply.text
            : 'caption' in reply && reply.caption
              ? reply.caption
              : '[non-text message]';
        content = `[replying to ${replyFrom}: "${replyText}"]\n${content}`;
      }

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Treat reply-to-bot as an implicit trigger (no @mention needed)
      if (reply && reply.from?.id === ctx.me?.id && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      this.lastUpdateAt = Date.now();
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  /**
   * Watchdog: periodically verify polling is alive by calling getMe.
   * If getMe fails repeatedly, restart polling.
   * We do NOT call getUpdates (which conflicts with the active poller).
   */
  private startPollingWatchdog(): void {
    this.lastUpdateAt = Date.now();
    let consecutiveFailures = 0;

    this.pollingMonitor = setInterval(async () => {
      if (!this.bot) return;

      try {
        await this.bot.api.getMe();
        consecutiveFailures = 0;
      } catch (err: any) {
        consecutiveFailures++;
        logger.warn(
          { err: err?.message, consecutiveFailures },
          'Telegram watchdog: getMe failed',
        );
        // Only restart after 3 consecutive failures (4.5 minutes of no connectivity)
        if (consecutiveFailures >= 3) {
          logger.warn('Telegram watchdog: restarting polling after repeated failures');
          consecutiveFailures = 0;
          try { this.bot.stop(); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 3000));
          this.bot.start({
            onStart: () => {
              logger.info('Telegram bot reconnected via watchdog');
              this.lastUpdateAt = Date.now();
            },
          });
        }
      }
    }, 90_000);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const numericId = jid.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;

    try {
      if (text.length <= MAX_LENGTH) {
        await this.bot!.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot!.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.pollingMonitor) {
      clearInterval(this.pollingMonitor);
      this.pollingMonitor = null;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
