// NanoClaw Monitor — Standalone dashboard for observing system state.
// Usage:  npx tsx src/monitor.ts
// Serves: http://localhost:3002

import http from 'http';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// --- Config ---

const PORT = parseInt(process.env.MONITOR_PORT || '3002', 10);
const UPSTREAM = process.env.UPSTREAM_DASHBOARD || 'http://localhost:3001';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const CONTACTS_DIR = path.join(PROJECT_ROOT, 'contacts');
const IPC_DIR = path.join(PROJECT_ROOT, 'data', 'ipc');
const USAGE_JSONL = path.join(PROJECT_ROOT, 'usage-report.jsonl');

// Refresh intervals (ms)
const JOBS_TTL = 2_000;
const TASKS_TTL = 10_000;
const SUBROUTINES_TTL = 10_000;
const INTERVIEWS_TTL = 60_000;
const HEALTH_TTL = 60_000;

// --- Types ---

interface UpstreamStatus {
  ts: string;
  pid: number;
  duplicateInstances: boolean;
  groups: Array<{
    groupJid: string;
    groupFolder: string | null;
    active: boolean;
    isTaskContainer: boolean;
    idleWaiting: boolean;
    containerName: string | null;
    invocationSource: string | null;
    contextPreview: string | null;
    pendingTaskCount: number;
    pendingMessages: boolean;
  }>;
}

interface TaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

interface TaskRunRow {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

interface Interview {
  contact: string;
  email: string | null;
  engagement: string;
  groupFolder: string;
  conversationState: string;
  itemsTotal: number;
  itemsAnswered: number;
  lastContact: string | null;
  crmStage: string | null;
}

interface GroupHealth {
  folder: string;
  claudeMdBytes: number;
  memoryFileCount: number;
  memoryBytes: number;
  totalContextKb: number;
}

interface CacheStats {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  periodMinutes: number;
}

interface UsageEntry {
  groupFolder: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
}

interface MonitorSnapshot {
  ts: string;
  pid: number;
  duplicateInstances: boolean;
  upstreamConnected: boolean;
  concurrency: { active: number; max: number };
  groups: UpstreamStatus['groups'];
  tasks: {
    upcoming: Array<{
      id: string;
      groupFolder: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      next_run: string | null;
      status: string;
    }>;
    recentRuns: Array<TaskRunRow>;
  };
  subroutines: {
    ipcPending: Array<{
      sourceGroup: string;
      file: string;
      timestamp: string;
    }>;
    idleWaiting: string[];
  };
  interviews: Interview[];
  health: {
    perGroup: GroupHealth[];
    cache: CacheStats;
    recentUsage: UsageEntry[];
  };
}

// --- Cached State ---

let jobsCache: { data: Partial<UpstreamStatus>; updatedAt: number } = {
  data: { groups: [], ts: '', pid: 0, duplicateInstances: false },
  updatedAt: 0,
};
let tasksCache: { data: MonitorSnapshot['tasks']; updatedAt: number } = {
  data: { upcoming: [], recentRuns: [] },
  updatedAt: 0,
};
let subroutinesCache: { data: MonitorSnapshot['subroutines']; updatedAt: number } = {
  data: { ipcPending: [], idleWaiting: [] },
  updatedAt: 0,
};
let interviewsCache: { data: Interview[]; updatedAt: number } = {
  data: [],
  updatedAt: 0,
};
let healthCache: { data: MonitorSnapshot['health']; updatedAt: number } = {
  data: {
    perGroup: [],
    cache: { totalInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, hitRate: 0, periodMinutes: 0 },
    recentUsage: [],
  },
  updatedAt: 0,
};

// --- DB ---

let db: Database.Database;

function initDb(): void {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
}

// --- Data Collectors ---

async function refreshJobs(): Promise<void> {
  try {
    const res = await fetch(`${UPSTREAM}/api/status`);
    if (res.ok) {
      jobsCache.data = (await res.json()) as Partial<UpstreamStatus>;
    }
  } catch {
    // upstream not reachable — keep stale data
  }
  jobsCache.updatedAt = Date.now();
}

function refreshTasks(): void {
  try {
    const upcoming = db
      .prepare(
        `SELECT id, group_folder, prompt, schedule_type, schedule_value, next_run, status
         FROM scheduled_tasks
         WHERE status = 'active'
         ORDER BY next_run ASC
         LIMIT 20`,
      )
      .all() as TaskRow[];

    const recentRuns = db
      .prepare(
        `SELECT trl.task_id, trl.run_at, trl.duration_ms, trl.status, trl.error,
                st.group_folder
         FROM task_run_logs trl
         LEFT JOIN scheduled_tasks st ON st.id = trl.task_id
         ORDER BY trl.run_at DESC
         LIMIT 15`,
      )
      .all() as (TaskRunRow & { group_folder?: string })[];

    tasksCache.data = {
      upcoming: upcoming.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt.length > 100 ? t.prompt.slice(0, 100) + '...' : t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        next_run: t.next_run,
        status: t.status,
      })),
      recentRuns: recentRuns.map((r) => ({
        task_id: r.task_id,
        run_at: r.run_at,
        duration_ms: r.duration_ms,
        status: r.status,
        result: null,
        error: r.error ? (r.error.length > 150 ? r.error.slice(0, 150) + '...' : r.error) : null,
      })),
    };
  } catch (err) {
    console.error('[monitor] refreshTasks error:', err);
  }
  tasksCache.updatedAt = Date.now();
}

function refreshSubroutines(): void {
  const ipcPending: MonitorSnapshot['subroutines']['ipcPending'] = [];
  const idleWaiting: string[] = [];

  try {
    // Scan IPC directories for pending messages
    if (fs.existsSync(IPC_DIR)) {
      const groups = fs.readdirSync(IPC_DIR, { withFileTypes: true });
      for (const g of groups) {
        if (!g.isDirectory()) continue;
        const msgsDir = path.join(IPC_DIR, g.name, 'messages');
        if (fs.existsSync(msgsDir)) {
          const files = fs.readdirSync(msgsDir).filter((f) => f.endsWith('.json'));
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(msgsDir, f));
              ipcPending.push({
                sourceGroup: g.name,
                file: f,
                timestamp: stat.mtime.toISOString(),
              });
            } catch {
              // skip unreadable files
            }
          }
        }

        // Check tasks dir for pending IPC task requests
        const tasksDir = path.join(IPC_DIR, g.name, 'tasks');
        if (fs.existsSync(tasksDir)) {
          const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(tasksDir, f));
              ipcPending.push({
                sourceGroup: g.name,
                file: `tasks/${f}`,
                timestamp: stat.mtime.toISOString(),
              });
            } catch {
              // skip
            }
          }
        }
      }
    }

    // Get idle-waiting groups from upstream data
    const groups = jobsCache.data.groups || [];
    for (const g of groups) {
      if (g.idleWaiting && g.groupFolder) {
        idleWaiting.push(g.groupFolder);
      }
    }
  } catch (err) {
    console.error('[monitor] refreshSubroutines error:', err);
  }

  subroutinesCache.data = { ipcPending, idleWaiting };
  subroutinesCache.updatedAt = Date.now();
}

function refreshInterviews(): void {
  const interviews: Interview[] = [];

  try {
    // Scan groups for managed_state_index.json
    if (!fs.existsSync(GROUPS_DIR)) return;
    const groupFolders = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });

    for (const gf of groupFolders) {
      if (!gf.isDirectory()) continue;
      const indexPath = path.join(GROUPS_DIR, gf.name, 'managed_state_index.json');
      if (!fs.existsSync(indexPath)) continue;

      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const contact = index.contact || index.contact_name || 'Unknown';
        const email = index.email || index.contact_email || null;
        const engagement = index.engagement || gf.name;

        // Try to read elicitation checklist
        let conversationState = 'unknown';
        let itemsTotal = 0;
        let itemsAnswered = 0;

        // Check for checklist path in state_files
        const checklistRelPath = index.state_files?.elicitation_checklist?.path || 'elicitation_checklist.json';
        const checklistPath = path.join(GROUPS_DIR, gf.name, checklistRelPath);

        if (fs.existsSync(checklistPath)) {
          try {
            const checklist = JSON.parse(fs.readFileSync(checklistPath, 'utf-8'));
            conversationState = checklist.conversation_state || 'active';
            if (Array.isArray(checklist.items)) {
              itemsTotal = checklist.items.length;
              itemsAnswered = checklist.items.filter(
                (i: { status?: string }) => i.status === 'answered',
              ).length;
            }
          } catch {
            // checklist unreadable
          }
        }

        // Cross-reference with contact state_index for CRM data
        let lastContact: string | null = null;
        let crmStage: string | null = null;
        const contactSlug = index.contact_slug;
        if (contactSlug) {
          const contactPath = path.join(CONTACTS_DIR, contactSlug, 'state_index.json');
          if (fs.existsSync(contactPath)) {
            try {
              const contactState = JSON.parse(fs.readFileSync(contactPath, 'utf-8'));
              lastContact = contactState.last_contact || null;
              crmStage = contactState.crm_stage || null;
            } catch {
              // skip
            }
          }
        }

        interviews.push({
          contact,
          email,
          engagement,
          groupFolder: gf.name,
          conversationState,
          itemsTotal,
          itemsAnswered,
          lastContact,
          crmStage,
        });
      } catch {
        // skip malformed index
      }
    }
  } catch (err) {
    console.error('[monitor] refreshInterviews error:', err);
  }

  interviewsCache.data = interviews;
  interviewsCache.updatedAt = Date.now();
}

function refreshHealth(): void {
  const perGroup: GroupHealth[] = [];

  try {
    // Measure context size per group
    if (fs.existsSync(GROUPS_DIR)) {
      const groupFolders = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
      for (const gf of groupFolders) {
        if (!gf.isDirectory()) continue;
        const folder = gf.name;

        let claudeMdBytes = 0;
        const claudeMdPath = path.join(GROUPS_DIR, folder, 'CLAUDE.md');
        if (fs.existsSync(claudeMdPath)) {
          try {
            claudeMdBytes = fs.statSync(claudeMdPath).size;
          } catch { /* skip */ }
        }

        let memoryFileCount = 0;
        let memoryBytes = 0;
        const memoryDir = path.join(GROUPS_DIR, folder, 'memory');
        if (fs.existsSync(memoryDir)) {
          try {
            const walk = (dir: string) => {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const e of entries) {
                const fullPath = path.join(dir, e.name);
                if (e.isDirectory()) {
                  walk(fullPath);
                } else {
                  memoryFileCount++;
                  try {
                    memoryBytes += fs.statSync(fullPath).size;
                  } catch { /* skip */ }
                }
              }
            };
            walk(memoryDir);
          } catch { /* skip */ }
        }

        const totalContextKb = Math.round((claudeMdBytes + memoryBytes) / 1024);
        perGroup.push({ folder, claudeMdBytes, memoryFileCount, memoryBytes, totalContextKb });
      }
    }

    // Sort by size descending
    perGroup.sort((a, b) => b.totalContextKb - a.totalContextKb);
  } catch (err) {
    console.error('[monitor] refreshHealth (groups) error:', err);
  }

  // Parse usage JSONL — tail last ~200 lines
  let cacheStats: CacheStats = {
    totalInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    hitRate: 0,
    periodMinutes: 0,
  };
  const recentUsage: UsageEntry[] = [];

  try {
    if (fs.existsSync(USAGE_JSONL)) {
      const content = fs.readFileSync(USAGE_JSONL, 'utf-8');
      const lines = content.trim().split('\n');
      const tail = lines.slice(-200);

      let earliestTs = '';
      let latestTs = '';

      for (const line of tail) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entry.timestamp || '';
          if (!earliestTs || ts < earliestTs) earliestTs = ts;
          if (!latestTs || ts > latestTs) latestTs = ts;

          cacheStats.totalInputTokens += entry.input_tokens || 0;
          cacheStats.cacheReadTokens += entry.cache_read_input_tokens || 0;
          cacheStats.cacheWriteTokens += entry.cache_creation_input_tokens || 0;

          recentUsage.push({
            groupFolder: entry.groupFolder || 'unknown',
            model: entry.model || 'unknown',
            inputTokens: (entry.input_tokens || 0) + (entry.cache_read_input_tokens || 0) + (entry.cache_creation_input_tokens || 0),
            outputTokens: entry.output_tokens || 0,
            timestamp: ts,
          });
        } catch {
          // skip malformed line
        }
      }

      if (earliestTs && latestTs) {
        const diffMs = new Date(latestTs).getTime() - new Date(earliestTs).getTime();
        cacheStats.periodMinutes = Math.round(diffMs / 60_000);
      }

      const totalCacheable = cacheStats.totalInputTokens + cacheStats.cacheReadTokens;
      cacheStats.hitRate = totalCacheable > 0
        ? cacheStats.cacheReadTokens / totalCacheable
        : 0;
    }
  } catch (err) {
    console.error('[monitor] refreshHealth (usage) error:', err);
  }

  // Keep only last 20 usage entries for the dashboard
  healthCache.data = {
    perGroup,
    cache: cacheStats,
    recentUsage: recentUsage.slice(-20),
  };
  healthCache.updatedAt = Date.now();
}

// --- Snapshot Builder ---

function buildSnapshot(): MonitorSnapshot {
  const now = Date.now();

  // Refresh stale caches (jobs is async, handled separately)
  if (now - tasksCache.updatedAt > TASKS_TTL) refreshTasks();
  if (now - subroutinesCache.updatedAt > SUBROUTINES_TTL) refreshSubroutines();
  if (now - interviewsCache.updatedAt > INTERVIEWS_TTL) refreshInterviews();
  if (now - healthCache.updatedAt > HEALTH_TTL) refreshHealth();

  const groups = jobsCache.data.groups || [];
  const activeCount = groups.filter((g) => g.active).length;

  return {
    ts: new Date().toISOString(),
    pid: jobsCache.data.pid || 0,
    duplicateInstances: jobsCache.data.duplicateInstances || false,
    upstreamConnected: jobsCache.updatedAt > 0 && now - jobsCache.updatedAt < 10_000,
    concurrency: { active: activeCount, max: 5 },
    groups,
    tasks: tasksCache.data,
    subroutines: subroutinesCache.data,
    interviews: interviewsCache.data,
    health: healthCache.data,
  };
}

// --- HTTP Server ---

function startServer(): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getMonitorHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      const interval = setInterval(() => {
        const snapshot = buildSnapshot();
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }, 2000);

      req.on('close', () => clearInterval(interval));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      const snapshot = buildSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  NanoClaw Monitor ready at http://localhost:${PORT}\n`);
  });
}

// --- Startup ---

async function main() {
  console.log('[monitor] Initializing...');
  console.log(`[monitor] DB: ${DB_PATH}`);
  console.log(`[monitor] Upstream: ${UPSTREAM}`);

  initDb();

  // Initial load of all panels
  console.log('[monitor] Loading active jobs...');
  await refreshJobs();
  console.log('[monitor] Loading scheduled tasks...');
  refreshTasks();
  console.log('[monitor] Loading subroutines...');
  refreshSubroutines();
  console.log('[monitor] Loading managed interviews...');
  refreshInterviews();
  console.log('[monitor] Loading context health...');
  refreshHealth();

  // Start async job polling
  setInterval(() => refreshJobs(), JOBS_TTL);

  console.log(`[monitor] Loaded: ${interviewsCache.data.length} interviews, ${tasksCache.data.upcoming.length} upcoming tasks, ${healthCache.data.perGroup.length} groups`);

  startServer();
}

main().catch((err) => {
  console.error('[monitor] Fatal:', err);
  process.exit(1);
});

// --- HTML ---

function getMonitorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NanoClaw Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{
    background:#0a0a0a;
    color:#c8c8c8;
    font-family:'JetBrains Mono','Fira Code',monospace;
    font-size:12px;
    line-height:1.5;
    min-height:100vh;
  }
  header{
    border-bottom:1px solid #1a1a1a;
    padding:12px 20px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    background:#0f0f0f;
    position:sticky;
    top:0;
    z-index:10;
  }
  header h1{font-size:13px;font-weight:600;color:#e0e0e0;letter-spacing:0.5px}
  header h1 .accent{color:#00ff88}
  .header-meta{font-size:10px;color:#555;display:flex;gap:14px;align-items:center}
  .header-meta .dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .dot.green{background:#00ff88}
  .dot.yellow{background:#ffaa00}
  .dot.red{background:#ff4444}
  .dot.grey{background:#444}

  .layout{
    display:grid;
    grid-template-columns:1fr 1fr;
    grid-template-rows:auto auto auto;
    gap:1px;
    background:#1a1a1a;
    min-height:calc(100vh - 45px);
  }
  .panel{
    background:#0d0d0d;
    padding:14px 16px;
    min-height:180px;
  }
  .panel-title{
    font-size:10px;
    font-weight:700;
    color:#555;
    text-transform:uppercase;
    letter-spacing:1px;
    margin-bottom:10px;
    display:flex;
    justify-content:space-between;
    align-items:center;
  }
  .panel-title .count{
    font-weight:400;
    color:#444;
  }

  /* Concurrency gauge */
  .gauge{
    display:flex;
    gap:3px;
    margin-bottom:12px;
  }
  .gauge-block{
    width:40px;
    height:6px;
    border-radius:2px;
    background:#1a1a1a;
    transition:background 0.3s;
  }
  .gauge-block.filled{background:#00ff88}
  .gauge-block.filled.warn{background:#ffaa00}
  .gauge-block.filled.crit{background:#ff4444}

  /* Job cards */
  .job-card{
    background:#111;
    border:1px solid #1e1e1e;
    border-left:3px solid #333;
    border-radius:3px;
    padding:8px 10px;
    margin-bottom:6px;
    transition:border-color 0.2s;
  }
  .job-card.active{border-left-color:#00ff88;background:#0f1a14}
  .job-card.idle{opacity:0.4}
  .job-card .job-header{display:flex;justify-content:space-between;align-items:center}
  .job-card .job-name{font-weight:600;font-size:12px;color:#ddd}
  .badge{
    display:inline-block;font-size:9px;font-weight:600;
    padding:1px 6px;border-radius:2px;letter-spacing:0.4px;text-transform:uppercase;
    margin-left:4px;
  }
  .badge.running{background:#00ff8820;color:#00ff88;border:1px solid #00ff8840}
  .badge.idle-b{background:#22222244;color:#555;border:1px solid #33333366}
  .badge.task-b{background:#ffaa0020;color:#ffaa00;border:1px solid #ffaa0040}
  .badge.source-b{background:#4488ff20;color:#4488ff;border:1px solid #4488ff40}
  .job-detail{font-size:10px;color:#666;margin-top:4px}
  .job-detail .dur{color:#ffaa00;font-variant-numeric:tabular-nums}
  .job-detail .dur.warn{color:#ff8800}
  .job-detail .dur.crit{color:#ff4444}
  .context-line{
    font-size:10px;color:#444;margin-top:4px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    max-width:100%;
  }

  /* Task list */
  .task-row{
    display:flex;justify-content:space-between;align-items:center;
    padding:4px 0;border-bottom:1px solid #141414;
    font-size:11px;
  }
  .task-row .task-time{color:#ffaa00;font-variant-numeric:tabular-nums;flex-shrink:0;width:55px}
  .task-row .task-group{color:#4488ff;flex-shrink:0;width:90px;overflow:hidden;text-overflow:ellipsis}
  .task-row .task-prompt{color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 8px}
  .run-dots{display:flex;gap:3px;margin-top:8px;flex-wrap:wrap}
  .run-dot{
    width:8px;height:8px;border-radius:2px;
    display:inline-block;cursor:default;
  }
  .run-dot.ok{background:#00ff88}
  .run-dot.err{background:#ff4444}
  .run-dot-label{font-size:9px;color:#444;margin-left:6px}

  /* Subroutines */
  .ipc-row{
    display:flex;align-items:center;gap:8px;
    padding:3px 0;font-size:11px;color:#888;
  }
  .ipc-row .arrow{color:#ffaa00}
  .ipc-row .ipc-type{
    font-size:9px;padding:1px 5px;border-radius:2px;
    background:#ffaa0015;color:#ffaa00;border:1px solid #ffaa0030;
  }
  .idle-tag{
    display:inline-block;font-size:10px;
    padding:2px 8px;border-radius:2px;margin:2px 4px 2px 0;
    background:#4488ff15;color:#4488ff;border:1px solid #4488ff30;
  }

  /* Interviews */
  .interview-card{
    background:#111;border:1px solid #1e1e1e;border-radius:3px;
    padding:8px 10px;margin-bottom:6px;
  }
  .interview-header{display:flex;justify-content:space-between;align-items:center}
  .interview-name{font-weight:600;font-size:11px;color:#ddd}
  .interview-engagement{font-size:10px;color:#666;margin-top:2px}
  .progress-bar{
    height:4px;background:#1a1a1a;border-radius:2px;margin-top:6px;overflow:hidden;
  }
  .progress-fill{height:100%;border-radius:2px;transition:width 0.3s}
  .progress-fill.low{background:#ff4444}
  .progress-fill.mid{background:#ffaa00}
  .progress-fill.high{background:#00ff88}
  .progress-fill.done{background:#4488ff}
  .interview-meta{font-size:9px;color:#555;margin-top:4px;display:flex;justify-content:space-between}
  .state-badge{
    font-size:9px;padding:1px 5px;border-radius:2px;
  }
  .state-badge.active{background:#00ff8815;color:#00ff88;border:1px solid #00ff8830}
  .state-badge.waiting{background:#ffaa0015;color:#ffaa00;border:1px solid #ffaa0030}
  .state-badge.complete{background:#4488ff15;color:#4488ff;border:1px solid #4488ff30}

  /* Health */
  .health-row{
    display:flex;align-items:center;gap:8px;
    padding:3px 0;font-size:11px;
  }
  .health-folder{color:#aaa;width:100px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis}
  .health-bar-bg{flex:1;height:6px;background:#1a1a1a;border-radius:2px;overflow:hidden}
  .health-bar-fill{height:100%;border-radius:2px}
  .health-bar-fill.ok{background:#00ff88}
  .health-bar-fill.warn{background:#ffaa00}
  .health-bar-fill.crit{background:#ff4444}
  .health-size{color:#666;width:50px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums}
  .stat-grid{
    display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;
  }
  .stat-box{
    background:#111;border:1px solid #1e1e1e;border-radius:3px;padding:8px 10px;
  }
  .stat-value{font-size:16px;font-weight:600;color:#e0e0e0;font-variant-numeric:tabular-nums}
  .stat-value.good{color:#00ff88}
  .stat-value.warn{color:#ffaa00}
  .stat-value.bad{color:#ff4444}
  .stat-label{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}

  .empty{color:#333;font-size:11px;padding:20px 0;text-align:center}

  /* Connection status */
  #conn{
    position:fixed;bottom:8px;right:8px;
    font-size:9px;padding:3px 8px;
    background:#111;border:1px solid #1a1a1a;border-radius:2px;
    color:#333;
  }
  #conn.ok{color:#00ff88}
  #conn.err{color:#ff4444}
</style>
</head>
<body>
<header>
  <h1><span class="accent">&gt;</span> NanoClaw Monitor</h1>
  <div class="header-meta">
    <span id="h-active"><span class="dot grey"></span>-- active</span>
    <span id="h-upstream"><span class="dot grey"></span>upstream</span>
    <span id="h-pid">PID --</span>
    <span id="h-clock"></span>
  </div>
</header>

<div class="layout">
  <!-- Panel 1: Active Jobs -->
  <div class="panel" id="p-jobs">
    <div class="panel-title">Active Jobs <span class="count" id="jobs-count"></span></div>
    <div class="gauge" id="gauge"></div>
    <div id="jobs-list"></div>
  </div>

  <!-- Panel 2: Planned Tasks -->
  <div class="panel" id="p-tasks">
    <div class="panel-title">Planned Tasks <span class="count" id="tasks-count"></span></div>
    <div id="tasks-upcoming"></div>
    <div style="margin-top:10px">
      <div class="panel-title" style="margin-bottom:6px">Recent Runs</div>
      <div class="run-dots" id="run-dots"></div>
    </div>
  </div>

  <!-- Panel 3: Subroutines -->
  <div class="panel" id="p-sub">
    <div class="panel-title">Subroutines</div>
    <div id="sub-ipc"></div>
    <div style="margin-top:8px">
      <div class="panel-title" style="margin-bottom:4px">Idle Waiting (IPC)</div>
      <div id="sub-idle"></div>
    </div>
  </div>

  <!-- Panel 4: Managed Interviews -->
  <div class="panel" id="p-interviews">
    <div class="panel-title">Managed Interviews <span class="count" id="int-count"></span></div>
    <div id="interviews-list"></div>
  </div>

  <!-- Panel 5: Context Health (full width) -->
  <div class="panel" style="grid-column:1/-1" id="p-health">
    <div class="panel-title">Session / Context Health</div>
    <div class="stat-grid" id="health-stats"></div>
    <div class="panel-title" style="margin-bottom:6px">Context Size by Group</div>
    <div id="health-groups"></div>
  </div>
</div>

<div id="conn" class="err">disconnected</div>

<script>
(function(){
  const activeSince = {};

  function fmt(ms){
    const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
    if(h>0)return h+'h '+String(m%60).padStart(2,'0')+'m';
    if(m>0)return m+'m '+String(s%60).padStart(2,'0')+'s';
    return s+'s';
  }
  function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
  function trunc(s,n){return s&&s.length>n?s.slice(0,n)+'...':s||''}
  function timeLabel(iso){
    if(!iso)return '--';
    const d=new Date(iso);
    return d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function relTime(iso){
    if(!iso)return '';
    const diff=new Date(iso).getTime()-Date.now();
    const mins=Math.round(diff/60000);
    if(mins<0)return Math.abs(mins)+'m ago';
    if(mins<60)return 'in '+mins+'m';
    const hrs=Math.round(mins/60);
    return 'in '+hrs+'h';
  }

  function updateClock(){
    document.getElementById('h-clock').textContent=new Date().toLocaleTimeString('en-US',{hour12:false});
  }
  setInterval(updateClock,1000);updateClock();

  function render(d){
    const now=Date.now();

    // Header
    const ac=d.concurrency.active;
    const dotClass=ac>0?'green':'grey';
    document.getElementById('h-active').innerHTML='<span class="dot '+dotClass+'"></span>'+ac+' active';
    document.getElementById('h-upstream').innerHTML='<span class="dot '+(d.upstreamConnected?'green':'red')+'"></span>upstream';
    document.getElementById('h-pid').textContent='PID '+(d.pid||'--');

    // Panel 1: Active Jobs
    document.getElementById('jobs-count').textContent=ac+'/'+d.concurrency.max;
    let gauge='';
    for(let i=0;i<d.concurrency.max;i++){
      const filled=i<ac;
      let cls='gauge-block';
      if(filled){
        cls+=' filled';
        if(ac>=d.concurrency.max)cls+=' crit';
        else if(ac>=d.concurrency.max-1)cls+=' warn';
      }
      gauge+='<div class="'+cls+'"></div>';
    }
    document.getElementById('gauge').innerHTML=gauge;

    // Track active-since
    for(const g of d.groups){
      if(g.active&&!activeSince[g.groupJid])activeSince[g.groupJid]=now;
      else if(!g.active)delete activeSince[g.groupJid];
    }

    const sorted=[...d.groups].sort((a,b)=>{
      if(a.active&&!b.active)return -1;
      if(!a.active&&b.active)return 1;
      return(a.groupFolder||'').localeCompare(b.groupFolder||'');
    });

    let jobsHtml='';
    for(const g of sorted){
      const label=g.groupFolder||g.groupJid.split('@')[0].slice(-8);
      const cardCls=g.active?'job-card active':'job-card idle';
      let badges='';
      if(g.active){
        badges+='<span class="badge running">running</span>';
        if(g.isTaskContainer)badges+='<span class="badge task-b">task</span>';
        if(g.invocationSource)badges+='<span class="badge source-b">'+esc(g.invocationSource)+'</span>';
      }else{
        badges+='<span class="badge idle-b">idle</span>';
      }
      let detail='';
      if(g.active&&activeSince[g.groupJid]){
        const elapsed=now-activeSince[g.groupJid];
        const durCls=elapsed>300000?'dur crit':elapsed>120000?'dur warn':'dur';
        detail='<span class="'+durCls+'">'+fmt(elapsed)+'</span>';
        if(g.containerName)detail+=' &middot; '+esc(g.containerName);
      }
      if(g.pendingTaskCount>0)detail+=' &middot; '+g.pendingTaskCount+' pending';
      let ctx='';
      if(g.contextPreview&&g.active)ctx='<div class="context-line">'+esc(trunc(g.contextPreview,100))+'</div>';

      jobsHtml+='<div class="'+cardCls+'">'
        +'<div class="job-header"><span class="job-name">'+esc(label)+'</span><div>'+badges+'</div></div>'
        +(detail?'<div class="job-detail">'+detail+'</div>':'')
        +ctx+'</div>';
    }
    document.getElementById('jobs-list').innerHTML=jobsHtml||'<div class="empty">No groups tracked</div>';

    // Panel 2: Planned Tasks
    document.getElementById('tasks-count').textContent=d.tasks.upcoming.length+' scheduled';
    let tasksHtml='';
    for(const t of d.tasks.upcoming.slice(0,10)){
      tasksHtml+='<div class="task-row">'
        +'<span class="task-time">'+relTime(t.next_run)+'</span>'
        +'<span class="task-group">'+esc(t.groupFolder)+'</span>'
        +'<span class="task-prompt" title="'+esc(t.prompt)+'">'+esc(trunc(t.prompt,60))+'</span>'
        +'</div>';
    }
    document.getElementById('tasks-upcoming').innerHTML=tasksHtml||'<div class="empty">No upcoming tasks</div>';

    let dotsHtml='';
    for(const r of d.tasks.recentRuns){
      const cls=r.status==='success'?'run-dot ok':'run-dot err';
      const title=timeLabel(r.run_at)+' '+r.status+(r.error?' — '+r.error:'');
      dotsHtml+='<span class="'+cls+'" title="'+esc(title)+'"></span>';
    }
    if(d.tasks.recentRuns.length>0){
      const successes=d.tasks.recentRuns.filter(r=>r.status==='success').length;
      dotsHtml+='<span class="run-dot-label">'+successes+'/'+d.tasks.recentRuns.length+' ok</span>';
    }
    document.getElementById('run-dots').innerHTML=dotsHtml||'<span class="empty">No runs yet</span>';

    // Panel 3: Subroutines
    let ipcHtml='';
    if(d.subroutines.ipcPending.length>0){
      for(const ipc of d.subroutines.ipcPending){
        ipcHtml+='<div class="ipc-row">'
          +'<span>'+esc(ipc.sourceGroup)+'</span>'
          +'<span class="arrow">&rarr;</span>'
          +'<span class="ipc-type">'+esc(ipc.file)+'</span>'
          +'<span style="color:#444;margin-left:auto">'+timeLabel(ipc.timestamp)+'</span>'
          +'</div>';
      }
    }else{
      ipcHtml='<div class="empty">No pending IPC</div>';
    }
    document.getElementById('sub-ipc').innerHTML=ipcHtml;

    let idleHtml='';
    if(d.subroutines.idleWaiting.length>0){
      for(const g of d.subroutines.idleWaiting){
        idleHtml+='<span class="idle-tag">'+esc(g)+'</span>';
      }
    }else{
      idleHtml='<span style="color:#333;font-size:10px">None</span>';
    }
    document.getElementById('sub-idle').innerHTML=idleHtml;

    // Panel 4: Managed Interviews
    document.getElementById('int-count').textContent=d.interviews.length+' tracked';
    let intHtml='';
    for(const iv of d.interviews){
      const pct=iv.itemsTotal>0?Math.round(iv.itemsAnswered/iv.itemsTotal*100):0;
      let fillCls='progress-fill';
      if(iv.conversationState==='elicitation_complete'||iv.conversationState==='complete')fillCls+=' done';
      else if(pct>=70)fillCls+=' high';
      else if(pct>=30)fillCls+=' mid';
      else fillCls+=' low';

      let stateCls='state-badge';
      if(iv.conversationState==='elicitation_complete'||iv.conversationState==='complete')stateCls+=' complete';
      else if(iv.conversationState==='waiting'||iv.conversationState==='pending')stateCls+=' waiting';
      else stateCls+=' active';

      intHtml+='<div class="interview-card">'
        +'<div class="interview-header">'
        +'<span class="interview-name">'+esc(iv.contact)+'</span>'
        +'<span class="'+stateCls+'">'+esc(iv.conversationState)+'</span>'
        +'</div>'
        +'<div class="interview-engagement">'+esc(iv.engagement)+(iv.crmStage?' &middot; '+esc(iv.crmStage):'')+'</div>'
        +'<div class="progress-bar"><div class="'+fillCls+'" style="width:'+pct+'%"></div></div>'
        +'<div class="interview-meta">'
        +'<span>'+iv.itemsAnswered+'/'+iv.itemsTotal+' questions</span>'
        +'<span>'+esc(iv.groupFolder)+(iv.lastContact?' &middot; last: '+iv.lastContact:'')+'</span>'
        +'</div>'
        +'</div>';
    }
    document.getElementById('interviews-list').innerHTML=intHtml||'<div class="empty">No managed interviews</div>';

    // Panel 5: Context Health
    const c=d.health.cache;
    const hitPct=Math.round(c.hitRate*100);
    const hitCls=hitPct>=80?'good':hitPct>=50?'warn':'bad';

    const totalIn=d.health.recentUsage.reduce((s,u)=>s+u.inputTokens,0);
    const totalOut=d.health.recentUsage.reduce((s,u)=>s+u.outputTokens,0);
    function fmtTokens(n){
      if(n>=1000000)return(n/1000000).toFixed(1)+'M';
      if(n>=1000)return(n/1000).toFixed(0)+'K';
      return String(n);
    }

    let statsHtml='<div class="stat-box"><div class="stat-value '+hitCls+'">'+hitPct+'%</div><div class="stat-label">Cache Hit Rate</div></div>'
      +'<div class="stat-box"><div class="stat-value">'+fmtTokens(totalIn)+' / '+fmtTokens(totalOut)+'</div><div class="stat-label">Input / Output (recent)</div></div>';
    document.getElementById('health-stats').innerHTML=statsHtml;

    const maxKb=Math.max(...d.health.perGroup.map(g=>g.totalContextKb),1);
    let ghHtml='';
    for(const g of d.health.perGroup.slice(0,12)){
      const pct=Math.round(g.totalContextKb/maxKb*100);
      let barCls='health-bar-fill';
      if(g.totalContextKb>50)barCls+=' crit';
      else if(g.totalContextKb>25)barCls+=' warn';
      else barCls+=' ok';

      ghHtml+='<div class="health-row">'
        +'<span class="health-folder" title="'+esc(g.folder)+'">'+esc(g.folder)+'</span>'
        +'<div class="health-bar-bg"><div class="'+barCls+'" style="width:'+pct+'%"></div></div>'
        +'<span class="health-size">'+g.totalContextKb+'KB</span>'
        +'</div>';
    }
    document.getElementById('health-groups').innerHTML=ghHtml||'<div class="empty">No groups</div>';
  }

  // Duration counter
  setInterval(function(){
    const els=document.querySelectorAll('.job-detail .dur');
    // durations are re-rendered every SSE tick, no need for separate counter
  },1000);

  // SSE
  let es=null,rt=null;
  function connect(){
    if(es)try{es.close()}catch(e){}
    es=new EventSource('/events');
    es.onopen=function(){
      document.getElementById('conn').textContent='connected';
      document.getElementById('conn').className='ok';
      if(rt){clearTimeout(rt);rt=null}
    };
    es.onmessage=function(e){
      try{render(JSON.parse(e.data))}catch(err){console.error(err)}
    };
    es.onerror=function(){
      document.getElementById('conn').textContent='disconnected';
      document.getElementById('conn').className='err';
      try{es.close()}catch(e){}
      if(!rt)rt=setTimeout(connect,3000);
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}
