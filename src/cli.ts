/**
 * NanoClaw CLI — Talk to Thomas from the terminal.
 *
 * Identical pipeline as Telegram: same container image, mounts, secrets,
 * skills, CLAUDE.md, model routing, and session persistence.
 *
 * Usage:
 *   npx tsx src/cli.ts "your message here"
 *   npx tsx src/cli.ts                      # interactive mode (stdin)
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import {
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAllChats,
  initDatabase,
  setSession,
} from './db.js';
import { startIpcWatcher } from './ipc.js';
import { formatOutbound } from './router.js';
import { GroupQueue } from './group-queue.js';
import { RegisteredGroup } from './types.js';
import { appendUsage } from './usage-tracker.js';
import { logger } from './logger.js';

// Synthetic JID for CLI channel — uses the same main group registration
const CLI_JID = 'cli:local';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
const queue = new GroupQueue();

function loadState(): void {
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
}

/**
 * Find the main group's JID and registration.
 * Falls back to synthesizing one if somehow missing.
 */
function getMainGroup(): { jid: string; group: RegisteredGroup } {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) {
      return { jid, group };
    }
  }
  throw new Error(
    'No registered main group found. Register Thomas on Telegram first, then use CLI.',
  );
}

async function runCli(prompt: string, mainJid: string, group: RegisteredGroup): Promise<void> {
  const isMain = true;
  const sessionId = sessions[group.folder];

  // Update snapshots (same as the Telegram path)
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

  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  const availableGroups = chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
  writeGroupsSnapshot(group.folder, isMain, availableGroups, registeredJids);

  // Format prompt like the Telegram path: "<sender> (timestamp):\n<content>"
  const ts = new Date().toISOString();
  const formatted = `Joel (${ts}):\n${prompt}`;

  const output = await runContainerAgent(
    group,
    {
      prompt: formatted,
      sessionId,
      groupFolder: group.folder,
      chatJid: mainJid, // Use real Telegram JID so IPC messages route to TG
      isMain,
    },
    (proc, containerName) => queue.registerProcess(mainJid, proc, containerName, group.folder),
    async (result: ContainerOutput) => {
      // Track session
      if (result.newSessionId) {
        sessions[group.folder] = result.newSessionId;
        setSession(group.folder, result.newSessionId);
      }
      // Track usage
      if (result.usage && (result.usage.input_tokens > 0 || result.usage.output_tokens > 0)) {
        appendUsage({
          timestamp: new Date().toISOString(),
          groupFolder: group.folder,
          model: result.model,
          sessionId: sessions[group.folder],
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
        });
      }
      // Print output to terminal
      if (result.result) {
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (text) {
          console.log('\n' + text + '\n');
        }
      }
      if (result.status === 'error' && result.error) {
        console.error(`[error] ${result.error}`);
      }
    },
  );

  if (output.status === 'error') {
    console.error(`[container error] ${output.error || 'unknown'}`);
  }
}

async function main(): Promise<void> {
  ensureContainerRuntimeRunning();
  initDatabase();
  loadState();

  const { jid: mainJid, group } = getMainGroup();
  logger.info(
    { jid: mainJid, group: group.name, folder: group.folder },
    'CLI connected to main group',
  );

  // Start IPC watcher so Thomas can send TG messages, register groups, etc.
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      // If IPC targets Telegram, print it but note it's outbound
      console.log(`[→ ${jid}] ${text}`);
    },
    injectMessage: (_chatJid, _text, _senderName) => {
      // CLI mode: no-op for inject_context
    },
    registeredGroups: () => registeredGroups,
    registerGroup: (jid, g) => {
      registeredGroups[jid] = g;
    },
    syncGroupMetadata: () => Promise.resolve(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  });

  // One-shot mode: message passed as CLI arg
  const inlineMessage = process.argv.slice(2).join(' ').trim();
  if (inlineMessage) {
    await runCli(inlineMessage, mainJid, group);
    process.exit(0);
  }

  // Interactive mode: read from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You → Thomas: ',
  });

  console.log('NanoClaw CLI — same pipeline as Telegram');
  console.log(`Group: ${group.name} (${group.folder}) | JID: ${mainJid}`);
  console.log(`Session: ${sessions[group.folder]?.slice(0, 12) || 'new'}...`);
  console.log('Type your message and press Enter. Paste multi-line freely — it sends after a brief pause.\n');
  rl.prompt();

  // Buffer lines and debounce: handles both single-line typing and multi-line paste.
  // Pasted lines arrive near-simultaneously; typed lines have natural pauses between them.
  const DEBOUNCE_MS = 300;
  let lineBuffer: string[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  const flush = async () => {
    const msg = lineBuffer.join('\n').trim();
    lineBuffer = [];
    if (!msg) {
      rl.prompt();
      return;
    }
    if (msg === '/quit' || msg === '/exit') {
      console.log('Bye.');
      process.exit(0);
    }
    if (busy) {
      console.log('[waiting for previous response...]\n');
      rl.prompt();
      return;
    }
    busy = true;
    try {
      await runCli(msg, mainJid, group);
    } catch (err) {
      console.error('[error]', err);
    }
    busy = false;
    rl.prompt();
  };

  rl.on('line', (line) => {
    lineBuffer.push(line);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  });

  rl.on('close', () => {
    console.log('\nBye.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('CLI failed to start:', err);
  process.exit(1);
});
