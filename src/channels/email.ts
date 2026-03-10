import fs from 'fs';
import https from 'https';
import path from 'path';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Types ---

interface GmailCredentials {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
    token_uri: string;
  };
}

export interface EmailAccountConfig {
  /** Display name for outbound emails, e.g. "Thomas Aquino" */
  displayName: string;
  /** Email address, e.g. "thomas@commitimpact.com" */
  address: string;
  /** Optional send-as alias, e.g. "thomas@arthurarchie.com" */
  sendAsAlias?: string;
  /** Path to gcp-oauth.keys.json */
  oauthKeysPath: string;
  /** Path to credentials.json (with refresh_token) */
  credentialsPath: string;
  /**
   * Route inbound emails to a different chat JID instead of email:{address}.
   * When set, inbound emails are stored under this JID so they appear in
   * that conversation's message stream (e.g., the main Telegram group).
   * The agent processes them with unified context across channels.
   */
  routeToJid?: string;
  /**
   * Sender patterns to ignore (case-insensitive substring match on From address).
   * E.g. ["noreply@", "no-reply@", "notifications@", "mailer-daemon@"]
   * Defaults to a built-in list if not specified.
   */
  ignoreSenderPatterns?: string[];
  /**
   * Gmail category labels to ignore. Messages with ANY of these labels are skipped.
   * Defaults to: CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES, CATEGORY_FORUMS
   */
  ignoreGmailCategories?: string[];
  /**
   * If true, also skip emails with automated/bulk headers
   * (List-Unsubscribe, Precedence: bulk/list, X-Auto-Response-Suppress, auto-submitted).
   * Defaults to true.
   */
  ignoreAutomated?: boolean;
  /**
   * Path to email-contacts.json allowlist.
   * If set, only senders in this list are processed.
   * Senders with isVip: true trigger agent invocation.
   * Non-VIP known senders get notification only.
   * Unknown senders are silently dropped.
   */
  contactAllowlistPath?: string;
  /**
   * Enable managed conversation routing for this account.
   * When true, inbound emails from senders with a managed_state_index.json
   * in a group directory are routed directly to that group's container
   * instead of the default routeToJid. The group processes with its own
   * CLAUDE.md and elicitation state — no context pollution to other groups.
   */
  enableManagedRouting?: boolean;
}

export interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Optional: send a notification to another channel (e.g. Telegram) when email arrives */
  notifyJid?: string;
  notifySend?: (jid: string, text: string) => Promise<void>;
}

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType: string;
    body?: { data?: string; size?: number };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string; size?: number };
      parts?: Array<{
        mimeType: string;
        body?: { data?: string; size?: number };
      }>;
    }>;
  };
  labelIds?: string[];
}

// --- Helpers ---

function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode || 0, data }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getHeader(msg: GmailMessage, name: string): string {
  const header = msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value || '';
}

function extractPlainText(payload: GmailMessage['payload']): string {
  // Try direct body first
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return base64UrlDecode(payload.body.data);
  }

  // Walk parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return base64UrlDecode(part.body.data);
      }
      // Nested multipart
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === 'text/plain' && sub.body?.data) {
            return base64UrlDecode(sub.body.data);
          }
        }
      }
    }
    // Fallback: try text/html and strip tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = base64UrlDecode(part.body.data);
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }

  // Last resort: direct body of any type
  if (payload.body?.data) {
    const decoded = base64UrlDecode(payload.body.data);
    if (payload.mimeType === 'text/html') {
      return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return decoded;
  }

  return '[Unable to extract email body]';
}

function parseEmailAddress(raw: string): { name: string; email: string } {
  // "Thomas Aquino <thomas@arthurarchie.com>" -> { name: "Thomas Aquino", email: "thomas@arthurarchie.com" }
  const match = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: raw, email: raw };
}

// --- Email Channel ---

const EMAIL_POLL_INTERVAL = 30_000; // 30 seconds
const TOKEN_REFRESH_BUFFER = 5 * 60_000; // Refresh 5 min before expiry

const DEFAULT_IGNORE_SENDER_PATTERNS = [
  'noreply@', 'no-reply@', 'no_reply@',
  'notifications@', 'notification@',
  'mailer-daemon@', 'postmaster@',
  'donotreply@', 'do-not-reply@', 'do_not_reply@',
  'bounce@', 'bounces@',
  'alerts@', 'alert@',
  'news@', 'newsletter@',
  'marketing@', 'promo@', 'promotions@',
  'support@', 'help@', 'info@',
  'updates@', 'update@',
  'billing@', 'invoice@', 'receipts@',
  'calendar-notification@google.com',
  'apps-scripts-notifications@google.com',
  'notify@',
];

const DEFAULT_IGNORE_GMAIL_CATEGORIES = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

export class EmailChannel implements Channel {
  name = 'email';

  private accounts: Map<string, EmailAccountConfig> = new Map();
  private credentials: Map<string, GmailCredentials> = new Map();
  private oauthKeys: Map<string, OAuthKeys> = new Map();
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private opts: EmailChannelOpts;
  /** Track last seen message per account to avoid re-processing */
  private lastSeenTimestamp: Map<string, number> = new Map();
  /** Track processed message IDs to deduplicate */
  private processedIds: Set<string> = new Set();
  /** Path to persist last-seen state */
  private statePath: string;
  /** Track last inbound email per JID for reply context */
  private lastInbound: Map<string, {
    from: string;
    subject: string;
    threadId: string;
    messageId: string;
  }> = new Map();
  /** Contact allowlist: email -> { name, isVip } */
  private contactAllowlist: Map<string, { name: string; isVip: boolean }> = new Map();
  private lastAllowlistLoad = 0;
  private static ALLOWLIST_RELOAD_INTERVAL = 5 * 60_000; // 5 minutes
  /** Track consecutive token refresh failures per account for backoff */
  private refreshFailures: Map<string, { count: number; nextRetryAt: number; alerted: boolean }> = new Map();
  /** Managed conversation routing: sender email → { folder, accountJid } */
  private managedRoutes: Map<string, { folder: string; accountJid: string }> = new Map();
  private lastManagedRoutesLoad = 0;
  private static MANAGED_ROUTES_RELOAD_INTERVAL = 5 * 60_000; // 5 minutes

  constructor(opts: EmailChannelOpts, statePath?: string) {
    this.opts = opts;
    this.statePath = statePath || path.join(process.cwd(), 'data', 'email-channel-state.json');
  }

  /** Register an email account to monitor */
  addAccount(config: EmailAccountConfig): void {
    const jid = `email:${config.address}`;
    this.accounts.set(jid, config);

    // Load OAuth keys
    try {
      const keysRaw = fs.readFileSync(config.oauthKeysPath, 'utf-8');
      this.oauthKeys.set(jid, JSON.parse(keysRaw));
    } catch (err) {
      logger.error({ jid, path: config.oauthKeysPath, err }, 'Failed to load OAuth keys');
    }

    // Load credentials (refresh token + possibly cached access token)
    try {
      const credsRaw = fs.readFileSync(config.credentialsPath, 'utf-8');
      this.credentials.set(jid, JSON.parse(credsRaw));
    } catch (err) {
      logger.error({ jid, path: config.credentialsPath, err }, 'Failed to load credentials');
    }

    logger.info({ jid, address: config.address }, 'Email account registered');
  }

  private loadAllowlist(): void {
    const account = Array.from(this.accounts.values())[0];
    if (!account?.contactAllowlistPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(account.contactAllowlistPath, 'utf-8'));
      this.contactAllowlist.clear();
      for (const c of raw.contacts ?? []) {
        this.contactAllowlist.set(c.email.toLowerCase(), { name: c.name, isVip: c.isVip ?? false });
      }
      this.lastAllowlistLoad = Date.now();
      logger.info({ count: this.contactAllowlist.size }, 'Email allowlist loaded');
    } catch (err) {
      logger.warn({ err }, 'Failed to load email allowlist — all non-filtered emails will pass');
    }
  }

  private loadManagedRoutes(): void {
    const groupsDir = path.join(process.cwd(), 'groups');
    if (!fs.existsSync(groupsDir)) return;

    // Find which accounts have managed routing enabled
    const managedAccountJids: string[] = [];
    for (const [jid, config] of this.accounts) {
      if (config.enableManagedRouting) managedAccountJids.push(jid);
    }
    if (managedAccountJids.length === 0) return;

    this.managedRoutes.clear();
    try {
      const folders = fs.readdirSync(groupsDir, { withFileTypes: true });
      for (const f of folders) {
        if (!f.isDirectory()) continue;
        const indexPath = path.join(groupsDir, f.name, 'managed_state_index.json');
        if (!fs.existsSync(indexPath)) continue;
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          const email = (index.contact_email || index.email || '').toLowerCase();
          if (!email) continue;
          // Map this sender to their managed group, using the first managed account
          this.managedRoutes.set(email, {
            folder: f.name,
            accountJid: managedAccountJids[0],
          });
        } catch {
          // skip malformed index
        }
      }
      this.lastManagedRoutesLoad = Date.now();
      if (this.managedRoutes.size > 0) {
        logger.info(
          { count: this.managedRoutes.size, routes: Object.fromEntries(this.managedRoutes) },
          'Managed conversation routes loaded',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load managed routes');
    }
  }

  async connect(): Promise<void> {
    if (this.accounts.size === 0) {
      logger.warn('EmailChannel: no accounts registered, skipping connect');
      return;
    }

    // Load persisted state
    this.loadState();

    // Load contact allowlist
    this.loadAllowlist();

    // Load managed conversation routes
    this.loadManagedRoutes();

    // Do an initial token refresh for all accounts
    for (const [jid] of this.accounts) {
      try {
        await this.ensureValidToken(jid);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to refresh token on connect');
      }
    }

    // Initialize lastSeenTimestamp for accounts that don't have persisted state
    for (const [jid] of this.accounts) {
      if (!this.lastSeenTimestamp.has(jid)) {
        // Start from now — don't process old emails on first connect
        this.lastSeenTimestamp.set(jid, Date.now());
      }
    }

    // Start polling
    this.pollTimer = setInterval(() => this.pollAllAccounts(), EMAIL_POLL_INTERVAL);
    this.connected = true;

    const accountList = Array.from(this.accounts.keys()).join(', ');
    logger.info({ accounts: accountList }, 'EmailChannel connected, polling started');
    console.log(`\n  Email channel: monitoring ${accountList}\n`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Resolve account — for managed JIDs, look up the parent account
    let account = this.accounts.get(jid);
    let accountJid = jid;
    if (!account && jid.startsWith('managed:')) {
      const folder = jid.slice('managed:'.length);
      // Find the account via managed routes
      for (const [, route] of this.managedRoutes) {
        if (route.folder === folder) {
          account = this.accounts.get(route.accountJid);
          accountJid = route.accountJid;
          break;
        }
      }
    }
    if (!account) {
      logger.warn({ jid }, 'EmailChannel.sendMessage: no account for JID');
      return;
    }

    const lastMsg = this.lastInbound.get(jid);
    if (!lastMsg) {
      logger.warn({ jid }, 'EmailChannel.sendMessage: no inbound message to reply to');
      return;
    }

    try {
      const token = await this.ensureValidToken(accountJid);
      const sender = parseEmailAddress(lastMsg.from);

      // Build the reply subject
      const subject = lastMsg.subject.startsWith('Re:')
        ? lastMsg.subject
        : `Re: ${lastMsg.subject}`;

      // Use send-as alias if configured, otherwise the account address
      const fromAddress = account.sendAsAlias || account.address;
      const fromHeader = `${account.displayName} <${fromAddress}>`;

      // Compose RFC 2822 message
      const messageParts = [
        `From: ${fromHeader}`,
        `To: ${sender.email}`,
        `Subject: ${subject}`,
        `In-Reply-To: ${lastMsg.messageId}`,
        `References: ${lastMsg.messageId}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        text,
      ];
      const rawMessage = base64UrlEncode(messageParts.join('\r\n'));

      // Send via Gmail API, threading into the same conversation
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;
      const body = JSON.stringify({
        raw: rawMessage,
        threadId: lastMsg.threadId,
      });

      const result = await httpsRequest(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }, body);

      if (result.statusCode === 200) {
        logger.info(
          { jid, to: sender.email, subject, threadId: lastMsg.threadId },
          'Email reply sent',
        );

        // Store our reply in the message DB for thread context on next turn
        this.opts.onMessage(jid, {
          id: `sent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: account.address,
          sender_name: `[Email Sent] ${account.displayName}`,
          content: `[EMAIL SENT]\nTo: ${sender.email}\nSubject: ${subject}\n---\n${text}`,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        });
      } else {
        logger.error(
          { jid, status: result.statusCode, response: result.data.slice(0, 500) },
          'Failed to send email reply',
        );
      }
    } catch (err) {
      logger.error({ jid, err }, 'Error sending email reply');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:') || jid.startsWith('managed:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.saveState();
    this.connected = false;
    logger.info('EmailChannel disconnected');
  }

  // --- Token Management ---

  private async ensureValidToken(jid: string): Promise<string> {
    const creds = this.credentials.get(jid);
    const keys = this.oauthKeys.get(jid);
    if (!creds || !keys) {
      throw new Error(`No credentials for ${jid}`);
    }

    // Check if token is still valid (with buffer)
    if (creds.access_token && creds.expiry_date > Date.now() + TOKEN_REFRESH_BUFFER) {
      return creds.access_token;
    }

    // Refresh the token
    const { installed } = keys;
    const body = new URLSearchParams({
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }).toString();

    const result = await httpsRequest(
      installed.token_uri,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      body,
    );

    if (result.statusCode !== 200) {
      // Track failure for backoff
      const failure = this.refreshFailures.get(jid) || { count: 0, nextRetryAt: 0, alerted: false };
      failure.count++;
      // Exponential backoff: 1min, 2min, 4min, 8min, capped at 30min
      const backoffMs = Math.min(60_000 * Math.pow(2, failure.count - 1), 30 * 60_000);
      failure.nextRetryAt = Date.now() + backoffMs;
      this.refreshFailures.set(jid, failure);

      const account = this.accounts.get(jid);
      logger.error(
        { jid, status: result.statusCode, failureCount: failure.count, nextRetryInMin: Math.round(backoffMs / 60_000) },
        'Token refresh failed, backing off',
      );

      // Send one-time alert to Telegram
      if (!failure.alerted && failure.count >= 3 && this.opts.notifyJid && this.opts.notifySend) {
        failure.alerted = true;
        const addr = account?.address || jid;
        this.opts.notifySend(this.opts.notifyJid,
          `\u{26A0}\u{FE0F} Email OAuth broken for ${addr}\n` +
          `Error: ${result.data.slice(0, 200)}\n` +
          `Failed ${failure.count} times. Polling paused with backoff.\n` +
          `Re-authorize the account and restart to fix.`,
        ).catch(() => {});
      }

      throw new Error(`Token refresh failed (${result.statusCode}): ${result.data}`);
    }

    // Reset failure tracking on success
    this.refreshFailures.delete(jid);

    const tokenData = JSON.parse(result.data);
    creds.access_token = tokenData.access_token;
    creds.expiry_date = Date.now() + (tokenData.expires_in || 3600) * 1000;
    this.credentials.set(jid, creds);

    // Persist refreshed token
    const account = this.accounts.get(jid);
    if (account) {
      try {
        fs.writeFileSync(
          account.credentialsPath,
          JSON.stringify(creds, null, 2),
        );
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to persist refreshed token');
      }
    }

    logger.debug({ jid }, 'Access token refreshed');
    return creds.access_token;
  }

  // --- Filtering ---

  private shouldIgnoreMessage(jid: string, msg: GmailMessage): boolean {
    const account = this.accounts.get(jid);
    if (!account) return false;

    const from = getHeader(msg, 'From').toLowerCase();

    // Check sender patterns
    const senderPatterns = account.ignoreSenderPatterns ?? DEFAULT_IGNORE_SENDER_PATTERNS;
    for (const pattern of senderPatterns) {
      if (from.includes(pattern.toLowerCase())) {
        logger.debug({ jid, from, pattern }, 'Email ignored: sender pattern match');
        return true;
      }
    }

    // Check Gmail category labels
    const ignoreCategories = account.ignoreGmailCategories ?? DEFAULT_IGNORE_GMAIL_CATEGORIES;
    if (msg.labelIds) {
      for (const label of ignoreCategories) {
        if (msg.labelIds.includes(label)) {
          logger.debug({ jid, from, label }, 'Email ignored: Gmail category');
          return true;
        }
      }
    }

    // Allowlist check — if configured, only known senders pass
    if (this.contactAllowlist.size > 0) {
      const senderEmail = parseEmailAddress(getHeader(msg, 'From')).email.toLowerCase();
      if (!this.contactAllowlist.has(senderEmail)) {
        logger.debug({ jid, from: senderEmail }, 'Email ignored: sender not in allowlist');
        return true;
      }
    }

    // Check automated/bulk email headers
    const ignoreAutomated = account.ignoreAutomated ?? true;
    if (ignoreAutomated) {
      if (getHeader(msg, 'List-Unsubscribe')) {
        logger.debug({ jid, from }, 'Email ignored: List-Unsubscribe header');
        return true;
      }
      const precedence = getHeader(msg, 'Precedence').toLowerCase();
      if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
        logger.debug({ jid, from, precedence }, 'Email ignored: Precedence header');
        return true;
      }
      const autoSubmitted = getHeader(msg, 'Auto-Submitted').toLowerCase();
      if (autoSubmitted && autoSubmitted !== 'no') {
        logger.debug({ jid, from }, 'Email ignored: Auto-Submitted header');
        return true;
      }
    }

    return false;
  }

  // --- Polling ---

  private async pollAllAccounts(): Promise<void> {
    // Reload allowlist periodically (hot-reload without restart)
    if (Date.now() - this.lastAllowlistLoad > EmailChannel.ALLOWLIST_RELOAD_INTERVAL) {
      this.loadAllowlist();
    }
    // Reload managed routes periodically
    if (Date.now() - this.lastManagedRoutesLoad > EmailChannel.MANAGED_ROUTES_RELOAD_INTERVAL) {
      this.loadManagedRoutes();
    }

    for (const [jid] of this.accounts) {
      try {
        await this.pollAccount(jid);
      } catch (err) {
        logger.error({ jid, err }, 'Error polling email account');
      }
    }
  }

  private async pollAccount(jid: string): Promise<void> {
    const account = this.accounts.get(jid);
    if (!account) return;

    // Skip accounts in backoff
    const failure = this.refreshFailures.get(jid);
    if (failure && Date.now() < failure.nextRetryAt) {
      return;
    }
    // If backoff expired, reload credentials from disk in case they were refreshed externally
    if (failure) {
      try {
        const credsRaw = fs.readFileSync(account.credentialsPath, 'utf-8');
        this.credentials.set(jid, JSON.parse(credsRaw));
        logger.info({ jid }, 'Reloaded credentials from disk after backoff');
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to reload credentials from disk');
      }
    }

    const token = await this.ensureValidToken(jid);
    const lastSeen = this.lastSeenTimestamp.get(jid) || Date.now();

    // Query for messages newer than our last seen timestamp
    // Using Gmail's `after:` search operator (epoch seconds)
    const afterEpoch = Math.floor(lastSeen / 1000);
    const query = encodeURIComponent(`in:inbox after:${afterEpoch}`);
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`;

    const result = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.statusCode !== 200) {
      logger.warn({ jid, status: result.statusCode }, 'Gmail list request failed');
      return;
    }

    const data = JSON.parse(result.data);
    if (!data.messages || data.messages.length === 0) return;

    // Process each new message (oldest first)
    const messageIds: string[] = data.messages
      .map((m: { id: string }) => m.id)
      .reverse();

    let newestTimestamp = lastSeen;

    for (const msgId of messageIds) {
      // Skip already processed
      if (this.processedIds.has(msgId)) continue;

      try {
        const msg = await this.fetchMessage(jid, token, msgId);
        if (!msg) continue;

        const internalDate = parseInt(msg.internalDate, 10);

        // Skip messages older than our cursor (Gmail's `after:` is approximate)
        if (internalDate <= lastSeen) continue;

        // Skip messages sent by us (SENT label)
        if (msg.labelIds?.includes('SENT') && !msg.labelIds?.includes('INBOX')) continue;

        // Skip drafts
        if (msg.labelIds?.includes('DRAFT')) continue;

        // Skip spam, notifications, and automated emails
        if (this.shouldIgnoreMessage(jid, msg)) {
          this.processedIds.add(msgId);
          if (internalDate > newestTimestamp) newestTimestamp = internalDate;
          continue;
        }

        await this.processInboundMessage(jid, msg);
        this.processedIds.add(msgId);

        if (internalDate > newestTimestamp) {
          newestTimestamp = internalDate;
        }
      } catch (err) {
        logger.error({ jid, msgId, err }, 'Error processing email message');
      }
    }

    // Advance cursor
    if (newestTimestamp > lastSeen) {
      this.lastSeenTimestamp.set(jid, newestTimestamp);
      this.saveState();
    }

    // Prune processedIds set (keep last 500)
    if (this.processedIds.size > 500) {
      const idsArray = Array.from(this.processedIds);
      this.processedIds = new Set(idsArray.slice(-300));
    }
  }

  private async fetchMessage(
    jid: string,
    token: string,
    messageId: string,
  ): Promise<GmailMessage | null> {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;

    const result = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (result.statusCode !== 200) {
      logger.warn({ jid, messageId, status: result.statusCode }, 'Failed to fetch message');
      return null;
    }

    return JSON.parse(result.data);
  }

  private async processInboundMessage(jid: string, msg: GmailMessage): Promise<void> {
    const from = getHeader(msg, 'From');
    const to = getHeader(msg, 'To');
    const subject = getHeader(msg, 'Subject');
    const date = getHeader(msg, 'Date');
    const messageId = getHeader(msg, 'Message-ID');
    const threadId = msg.threadId;

    const sender = parseEmailAddress(from);
    const body = extractPlainText(msg.payload);

    // Truncate very long emails for the message pipeline
    const maxBodyLength = 3000;
    const truncatedBody = body.length > maxBodyLength
      ? body.slice(0, maxBodyLength) + '\n\n[... truncated — full email available via Gmail API]'
      : body;

    // Format the email as a structured message for the agent
    const content = [
      `[EMAIL RECEIVED]`,
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Thread: ${threadId}`,
      `Message-ID: ${messageId}`,
      `Gmail-ID: ${msg.id}`,
      `---`,
      truncatedBody,
    ].join('\n');

    const timestamp = new Date(parseInt(msg.internalDate, 10)).toISOString();

    const account = this.accounts.get(jid);
    const senderEmail = sender.email.toLowerCase();
    const contact = this.contactAllowlist.get(senderEmail);
    const isVip = contact?.isVip ?? false;
    const hasAllowlist = this.contactAllowlist.size > 0;

    // Check managed conversation routing first (only for accounts with it enabled)
    const managedRoute = account?.enableManagedRouting
      ? this.managedRoutes.get(senderEmail)
      : undefined;

    // Four-tier routing:
    // Managed: route to the sender's dedicated group container → full context isolation
    // VIP: route to account's default JID → triggers agent invocation
    // Non-VIP known: notification only → agent pulls via Gmail MCP on demand
    // Unknown (no allowlist): legacy behavior — route everything
    let targetJid: string | null;
    let routeLabel: string;

    if (managedRoute) {
      // Sender has a dedicated group — route directly there
      targetJid = `managed:${managedRoute.folder}`;
      routeLabel = 'managed';
    } else {
      const shouldInvokeAgent = !hasAllowlist || isVip;
      targetJid = shouldInvokeAgent ? (account?.routeToJid || jid) : null;
      routeLabel = isVip ? 'vip' : 'default';
    }

    if (targetJid) {
      // Store chat metadata (always under the email JID for discovery)
      this.opts.onChatMetadata(jid, timestamp, `Email: ${sender.email}`, 'email');

      // Also register the managed JID so the orchestrator knows about it
      if (managedRoute) {
        this.opts.onChatMetadata(targetJid, timestamp, `Managed: ${sender.email}`, 'email', false);
      }

      // Deliver as inbound message under the target JID
      const vipPrefix = managedRoute ? '[Managed]' : isVip ? '[VIP Email]' : '[Email]';
      this.opts.onMessage(targetJid, {
        id: msg.id,
        chat_jid: targetJid,
        sender: sender.email,
        sender_name: `${vipPrefix} ${sender.name || sender.email}`,
        content,
        timestamp,
        is_from_me: false,
      });
    }

    // Track reply context — store under both the account JID and the managed JID
    // so sendMessage() works from either context
    const replyContext = { from, subject, threadId, messageId };
    this.lastInbound.set(jid, replyContext);
    if (managedRoute) {
      this.lastInbound.set(`managed:${managedRoute.folder}`, replyContext);
    }

    logger.info(
      { jid, targetJid, route: routeLabel, from: sender.email, subject, gmailId: msg.id, managedFolder: managedRoute?.folder },
      'Email message processed',
    );

    // Cross-channel notification (e.g. to Telegram) — for both VIP and non-VIP known contacts
    if (this.opts.notifyJid && this.opts.notifySend) {
      const summaryLines = truncatedBody.split('\n').slice(0, 5).join('\n');
      const vipTag = isVip ? '\u{2B50} *VIP* ' : '';
      const notify = [
        `\u{1F4E7} ${vipTag}*New Email*`,
        `From: ${sender.name} (${sender.email})`,
        `Subject: ${subject}`,
        `---`,
        summaryLines.length > 300 ? summaryLines.slice(0, 300) + '...' : summaryLines,
      ].join('\n');

      try {
        await this.opts.notifySend(this.opts.notifyJid, notify);
        logger.debug({ jid, notifyJid: this.opts.notifyJid }, 'Email notification sent to Telegram');
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to send email notification to Telegram');
      }
    }
  }

  // --- State Persistence ---

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
        if (raw.lastSeenTimestamp) {
          for (const [jid, ts] of Object.entries(raw.lastSeenTimestamp)) {
            this.lastSeenTimestamp.set(jid, ts as number);
          }
        }
        if (raw.processedIds) {
          this.processedIds = new Set(raw.processedIds);
        }
        logger.debug('Email channel state loaded');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load email channel state');
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const state = {
        lastSeenTimestamp: Object.fromEntries(this.lastSeenTimestamp),
        processedIds: Array.from(this.processedIds).slice(-300),
      };
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save email channel state');
    }
  }
}
