import http from 'http';
import { execSync } from 'child_process';

import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

interface DashboardOptions {
  port: number;
}

export function startDashboard(
  queue: GroupQueue,
  options: DashboardOptions,
): void {
  const { port } = options;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHtml());
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
        const snapshot = buildSnapshot(queue);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }, 2000);

      req.on('close', () => clearInterval(interval));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const snapshot = buildSnapshot(queue);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/cancel/')) {
      const groupJid = decodeURIComponent(
        url.pathname.slice('/cancel/'.length),
      );
      const ok = queue.cancelGroup(groupJid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, `Dashboard available at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    logger.warn({ err, port }, 'Dashboard server error (non-fatal)');
  });
}

function buildSnapshot(queue: GroupQueue) {
  let duplicateInstances = false;
  try {
    const result = execSync(
      'pgrep -f "node.*nanoclaw" 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 2000 },
    );
    const pids = result.trim().split('\n').filter(Boolean);
    duplicateInstances = pids.length > 1;
  } catch {
    // ignore
  }

  const groups = queue.getStatus();
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    duplicateInstances,
    groups,
  };
}

function getDashboardHtml(): string {
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
    background:#0d0d0d;
    color:#c8c8c8;
    font-family:'JetBrains Mono','Fira Code',monospace;
    font-size:13px;
    line-height:1.5;
    min-height:100vh;
  }
  #duplicate-banner{
    display:none;
    background:#b8860b;
    color:#0d0d0d;
    text-align:center;
    padding:8px 16px;
    font-weight:600;
    font-size:12px;
    letter-spacing:0.5px;
  }
  #duplicate-banner.visible{display:block}
  header{
    border-bottom:1px solid #1a1a1a;
    padding:16px 24px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    background:#111111;
  }
  header h1{
    font-size:14px;
    font-weight:600;
    color:#e0e0e0;
    letter-spacing:0.5px;
  }
  header h1 .accent{color:#00ff88}
  header .meta{
    font-size:11px;
    color:#666;
    display:flex;
    gap:16px;
  }
  header .meta .dot{
    display:inline-block;
    width:6px;height:6px;
    border-radius:50%;
    margin-right:6px;
    vertical-align:middle;
  }
  header .meta .dot.green{background:#00ff88}
  header .meta .dot.red{background:#ff4444}
  .container{
    padding:20px 24px;
    max-width:1200px;
    margin:0 auto;
  }
  .grid{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(520px,1fr));
    gap:12px;
  }
  @media(max-width:600px){
    .grid{grid-template-columns:1fr}
  }
  .card{
    background:#141414;
    border:1px solid #1e1e1e;
    border-left:3px solid #333;
    border-radius:4px;
    padding:14px 16px;
    transition:border-color 0.2s,opacity 0.2s;
  }
  .card.active{
    border-left-color:#00ff88;
    background:#0f1a14;
  }
  .card.idle{
    opacity:0.55;
  }
  .card.idle:hover{opacity:0.8}
  .card-header{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    margin-bottom:8px;
  }
  .card-title{
    font-size:13px;
    font-weight:600;
    color:#e0e0e0;
    word-break:break-all;
  }
  .badge{
    display:inline-block;
    font-size:10px;
    font-weight:600;
    padding:2px 8px;
    border-radius:3px;
    letter-spacing:0.5px;
    text-transform:uppercase;
    flex-shrink:0;
    margin-left:8px;
  }
  .badge.running{background:#00ff8822;color:#00ff88;border:1px solid #00ff8844}
  .badge.idle-badge{background:#33333344;color:#666;border:1px solid #33333388}
  .badge.task{background:#ffaa0022;color:#ffaa00;border:1px solid #ffaa0044}
  .badge.source{background:#4488ff22;color:#4488ff;border:1px solid #4488ff44}
  .card-body{font-size:11px;color:#888}
  .card-body .row{
    display:flex;
    justify-content:space-between;
    align-items:center;
    padding:3px 0;
  }
  .card-body .label{color:#555}
  .card-body .value{color:#aaa}
  .card-body .value.duration{color:#ffaa00;font-variant-numeric:tabular-nums}
  .context-preview{
    margin-top:8px;
    padding:8px 10px;
    background:#0d0d0d;
    border:1px solid #1a1a1a;
    border-radius:3px;
    font-size:11px;
    color:#777;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    max-width:100%;
  }
  .card-actions{
    margin-top:10px;
    display:flex;
    justify-content:flex-end;
  }
  .btn-cancel{
    font-family:inherit;
    font-size:10px;
    font-weight:600;
    padding:4px 12px;
    background:transparent;
    color:#ff4444;
    border:1px solid #ff444444;
    border-radius:3px;
    cursor:pointer;
    letter-spacing:0.5px;
    text-transform:uppercase;
    transition:background 0.15s,color 0.15s;
  }
  .btn-cancel:hover{
    background:#ff4444;
    color:#0d0d0d;
  }
  .empty-state{
    text-align:center;
    padding:60px 20px;
    color:#444;
    font-size:12px;
  }
  .empty-state .icon{font-size:32px;margin-bottom:12px;opacity:0.3}
  #connection-status{
    position:fixed;
    bottom:12px;
    right:12px;
    font-size:10px;
    color:#333;
    padding:4px 10px;
    background:#111;
    border:1px solid #1a1a1a;
    border-radius:3px;
  }
  #connection-status.connected{color:#00ff88}
  #connection-status.disconnected{color:#ff4444}
</style>
</head>
<body>
<div id="duplicate-banner">
  WARNING: Multiple NanoClaw instances detected. This can cause race conditions and duplicate message processing.
</div>
<header>
  <h1><span class="accent">&gt;</span> NanoClaw Monitor <span id="header-detail"></span></h1>
  <div class="meta">
    <span id="active-count"><span class="dot green"></span>0 active</span>
    <span id="pid-display">PID --</span>
    <span id="clock"></span>
  </div>
</header>
<div class="container">
  <div class="grid" id="grid"></div>
  <div class="empty-state" id="empty-state" style="display:none">
    <div class="icon">_</div>
    <div>No groups tracked yet. Groups appear once they receive their first message.</div>
  </div>
</div>
<div id="connection-status" class="disconnected">disconnected</div>

<script>
(function(){
  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('empty-state');
  const headerDetail = document.getElementById('header-detail');
  const activeCountEl = document.getElementById('active-count');
  const pidDisplay = document.getElementById('pid-display');
  const clockEl = document.getElementById('clock');
  const connStatus = document.getElementById('connection-status');
  const dupBanner = document.getElementById('duplicate-banner');

  // Track when each group became active (for duration counter)
  const activeSince = {};

  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-US',{hour12:false});
  }
  setInterval(updateClock, 1000);
  updateClock();

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + String(m % 60).padStart(2,'0') + 'm ' + String(s % 60).padStart(2,'0') + 's';
    if (m > 0) return m + 'm ' + String(s % 60).padStart(2,'0') + 's';
    return s + 's';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function folderLabel(g) {
    return g.groupFolder || g.groupJid.split('@')[0].slice(-8);
  }

  function render(data) {
    // Update header
    const activeGroups = data.groups.filter(g => g.active);
    const dot = activeGroups.length > 0 ? 'green' : 'red';
    activeCountEl.innerHTML = '<span class="dot ' + dot + '"></span>' + activeGroups.length + ' active';
    pidDisplay.textContent = 'PID ' + data.pid;

    // Duplicate instance warning
    if (data.duplicateInstances) {
      dupBanner.classList.add('visible');
    } else {
      dupBanner.classList.remove('visible');
    }

    if (data.groups.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }
    grid.style.display = 'grid';
    emptyState.style.display = 'none';

    // Track active-since timestamps
    const now = Date.now();
    for (const g of data.groups) {
      if (g.active && !activeSince[g.groupJid]) {
        activeSince[g.groupJid] = now;
      } else if (!g.active) {
        delete activeSince[g.groupJid];
      }
    }

    // Sort: active first, then by folder name
    const sorted = [...data.groups].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return folderLabel(a).localeCompare(folderLabel(b));
    });

    grid.innerHTML = sorted.map(g => {
      const isActive = g.active;
      const cardClass = isActive ? 'card active' : 'card idle';
      const label = folderLabel(g);

      let badges = '';
      if (isActive) {
        badges += '<span class="badge running">running</span>';
        if (g.isTaskContainer) badges += '<span class="badge task">task</span>';
        if (g.invocationSource) badges += '<span class="badge source">' + escapeHtml(g.invocationSource) + '</span>';
      } else {
        badges += '<span class="badge idle-badge">idle</span>';
      }

      let body = '';
      if (isActive) {
        const elapsed = activeSince[g.groupJid] ? now - activeSince[g.groupJid] : 0;
        body += '<div class="row"><span class="label">duration</span><span class="value duration" data-jid="' + escapeAttr(g.groupJid) + '">' + formatDuration(elapsed) + '</span></div>';
        if (g.containerName) {
          body += '<div class="row"><span class="label">container</span><span class="value">' + escapeHtml(g.containerName) + '</span></div>';
        }
      }
      if (g.pendingTaskCount > 0) {
        body += '<div class="row"><span class="label">pending tasks</span><span class="value">' + g.pendingTaskCount + '</span></div>';
      }
      if (g.pendingMessages) {
        body += '<div class="row"><span class="label">pending msgs</span><span class="value">yes</span></div>';
      }
      if (g.idleWaiting && isActive) {
        body += '<div class="row"><span class="label">state</span><span class="value">idle-waiting (IPC)</span></div>';
      }

      let contextBlock = '';
      if (g.contextPreview && isActive) {
        contextBlock = '<div class="context-preview" title="' + escapeAttr(g.contextPreview) + '">' + escapeHtml(truncate(g.contextPreview, 120)) + '</div>';
      }

      let actions = '';
      if (isActive) {
        actions = '<div class="card-actions"><button class="btn-cancel" onclick="cancelGroup(\\'' + escapeJs(g.groupJid) + '\\')">cancel</button></div>';
      }

      return '<div class="' + cardClass + '">'
        + '<div class="card-header"><span class="card-title">' + escapeHtml(label) + '</span><div>' + badges + '</div></div>'
        + '<div class="card-body">' + body + '</div>'
        + contextBlock
        + actions
        + '</div>';
    }).join('');
  }

  // Update duration counters every second without full re-render
  setInterval(function() {
    const els = document.querySelectorAll('.value.duration[data-jid]');
    const now = Date.now();
    els.forEach(function(el) {
      const jid = el.getAttribute('data-jid');
      if (activeSince[jid]) {
        el.textContent = formatDuration(now - activeSince[jid]);
      }
    });
  }, 1000);

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escapeAttr(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeJs(s) {
    if (!s) return '';
    return s.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
  }

  window.cancelGroup = function(jid) {
    if (!confirm('Cancel the running container for this group?')) return;
    fetch('/cancel/' + encodeURIComponent(jid), { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (!d.ok) alert('Cancel failed: container may have already stopped.'); })
      .catch(e => alert('Cancel error: ' + e.message));
  };

  // SSE with reconnect
  let evtSource = null;
  let reconnectTimer = null;

  function connectSSE() {
    if (evtSource) { try { evtSource.close(); } catch(e){} }
    evtSource = new EventSource('/events');

    evtSource.onopen = function() {
      connStatus.textContent = 'connected';
      connStatus.className = 'connected';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    evtSource.onmessage = function(e) {
      try {
        const data = JSON.parse(e.data);
        render(data);
      } catch(err) { console.error('Parse error:', err); }
    };

    evtSource.onerror = function() {
      connStatus.textContent = 'disconnected';
      connStatus.className = 'disconnected';
      try { evtSource.close(); } catch(e){}
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(connectSSE, 3000);
      }
    };
  }

  connectSSE();
})();
</script>
</body>
</html>`;
}
