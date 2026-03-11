import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CLAUDE_UPGRADE_MODEL,
  DASHBOARD_PORT,
  DATA_DIR,
  EMAIL_CHANNEL_ENABLED,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  RECOVERY_SWEEP_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TRIGGER_PATTERN,
  isBusinessHours,
} from './config.js';
import { EmailChannel } from './channels/email.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import { startDashboard } from './dashboard.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { clearIpcSent, hasIpcSent, startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { appendUsage } from './usage-tracker.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let mainChatJid: string | undefined;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  // Resolve main group's chatJid for managed containers to report upstream
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  );
  mainChatJid = mainEntry?.[0];
  logger.info(
    { groupCount: Object.keys(registeredGroups).length, mainChatJid: mainChatJid || 'NOT_FOUND' },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Clear IPC-sent tracking for this chat so we can detect fresh sends
  clearIpcSent(chatJid);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Suppress streaming delivery if IPC already sent a message to this
        // chat. send_message is cross-group only, so ipcSent is only set when
        // another group routes to this chat — streaming would be a duplicate.
        if (hasIpcSent(chatJid)) {
          logger.debug(
            { group: group.name },
            'Streaming output suppressed (IPC already delivered to this chat)',
          );
        } else {
          await channel.sendMessage(chatJid, text);
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  // Managed groups don't resume sessions — each email is a fresh turn.
  // Resuming can crash if the previous session had different MCP tools.
  const isManaged = chatJid.startsWith('managed:');
  const sessionId = isManaged ? undefined : sessions[group.folder];

  // Detect /opus trigger in message — upgrades this invocation to Opus
  const opusPattern = /\/opus\b/i;
  const useOpus = opusPattern.test(prompt);
  if (useOpus) {
    prompt = prompt.replace(opusPattern, '').trim();
    logger.info({ group: group.name }, 'Opus model override detected');
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.usage && (output.usage.input_tokens > 0 || output.usage.output_tokens > 0)) {
          appendUsage({
            timestamp: new Date().toISOString(),
            groupFolder: group.folder,
            model: output.model,
            sessionId: sessions[group.folder],
            input_tokens: output.usage.input_tokens,
            output_tokens: output.usage.output_tokens,
            cache_creation_input_tokens: output.usage.cache_creation_input_tokens,
            cache_read_input_tokens: output.usage.cache_read_input_tokens,
          });
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        ...(useOpus ? { model: CLAUDE_UPGRADE_MODEL } : {}),
        // Give managed containers a path to report upstream to main
        ...(!isMain && chatJid.startsWith('managed:') && mainChatJid
          ? { mainChatJid }
          : {}),
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder, 'message', prompt.slice(0, 200)),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  // Periodic recovery sweep — catches messages that fell through after
  // retry exhaustion. Runs every RECOVERY_SWEEP_INTERVAL (default 60s).
  let lastRecoverySweep = Date.now();

  while (true) {
    // Recovery sweep for abandoned messages
    if (Date.now() - lastRecoverySweep >= RECOVERY_SWEEP_INTERVAL) {
      recoverPendingMessages();
      lastRecoverySweep = Date.now();
    }
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          // Gate managed conversations to business hours only.
          // Messages stay in DB and will be processed when hours resume.
          if (chatJid.startsWith('managed:') && !isBusinessHours()) {
            continue;
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            // Reset IPC-sent flag so a new user turn isn't suppressed by a
            // send_message call Thomas made in a previous turn.
            clearIpcSent(chatJid);
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Skip managed conversations outside business hours
    if (chatJid.startsWith('managed:') && !isBusinessHours()) continue;

    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Scan groups with managed_state_index.json and register them as managed groups.
 * These groups get their own container for context-isolated email conversations.
 */
function registerManagedGroups(): void {
  const groupsDir = path.join(DATA_DIR, '..', 'groups');
  if (!fs.existsSync(groupsDir)) return;

  const existingFolders = new Set(
    Object.values(registeredGroups).map((g) => g.folder),
  );

  try {
    const folders = fs.readdirSync(groupsDir, { withFileTypes: true });
    for (const f of folders) {
      if (!f.isDirectory()) continue;
      const indexPath = path.join(groupsDir, f.name, 'managed_state_index.json');
      if (!fs.existsSync(indexPath)) continue;

      const managedJid = `managed:${f.name}`;
      // Skip if this folder is already registered under any JID
      if (existingFolders.has(f.name)) continue;

      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const name = index.contact_name || index.contact || f.name;
        registerGroup(managedJid, {
          name: `Managed: ${name}`,
          folder: f.name,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false, // All messages trigger — no @Thomas needed
        });
        logger.info(
          { folder: f.name, jid: managedJid },
          'Auto-registered managed conversation group',
        );
      } catch {
        // skip malformed index
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to scan for managed groups');
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Auto-register managed conversation groups so the message loop processes them
  registerManagedGroups();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect Telegram channel
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is required. Set it in .env and restart.');
    process.exit(1);
  }
  const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
  channels.push(telegram);
  await telegram.connect();

  // Create and connect Email channel (if enabled)
  if (EMAIL_CHANNEL_ENABLED) {
    const emailConfigPath = path.join(DATA_DIR, 'email-accounts.json');
    if (fs.existsSync(emailConfigPath)) {
      try {
        const emailAccounts = JSON.parse(fs.readFileSync(emailConfigPath, 'utf-8'));

        // Find the main group's JID for cross-channel notifications
        const mainEntry = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === MAIN_GROUP_FOLDER,
        );
        const mainJid = mainEntry?.[0];

        const email = new EmailChannel({
          ...channelOpts,
          notifyJid: mainJid,
          notifySend: mainJid
            ? async (jid, text) => {
                // Route through Telegram channel for notifications
                const tgChannel = findChannel(channels, jid);
                if (tgChannel) await tgChannel.sendMessage(jid, text);
              }
            : undefined,
        });
        for (const account of emailAccounts) {
          email.addAccount(account);
        }
        channels.push(email);
        await email.connect();
        logger.info('Email channel connected');
      } catch (err) {
        logger.error({ err }, 'Failed to start email channel');
      }
    } else {
      logger.warn({ path: emailConfigPath }, 'EMAIL_CHANNEL_ENABLED=true but no email-accounts.json found');
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    mainChatJid: () => mainChatJid,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder, 'scheduled'),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    injectMessage: (chatJid, text, senderName) => {
      storeMessage({
        id: `inject-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        chat_jid: chatJid,
        sender: 'joel',
        sender_name: senderName,
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
      // Trigger the message loop to pick up the injected message
      queue.enqueueMessageCheck(chatJid);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: () => Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startDashboard(queue, { port: DASHBOARD_PORT });
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
