process.on('uncaughtException',  (err)    => console.error('[Fatal] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Fatal] Rejection:', reason));

const mineflayer = require('mineflayer');
const express    = require('express');
const http       = require('http');

const WEB_PORT  = parseInt(process.env.PORT || '3000');
const startedAt = Date.now();

// ── Server list ────────────────────────────────────────────────────────────────
const SERVER_CONFIGS = [
  {
    id:      'soneblock',
    label:   'Soneblock',
    ip:      'soneblock.aternos.me',
    port:    55424,
    name:    'StayBot_AFK',
    version: '1.21.1',
  },
  {
    id:      'blackend12',
    label:   'Blackend12',
    ip:      'blackend12.aternos.me',
    port:    22604,
    name:    'StayBot_AFK',
    version: '1.21.1',
  },
];

// ── Bot instance factory ───────────────────────────────────────────────────────
// Each server gets a fully-isolated instance with its own state and timers.
function makeBotInstance(cfg) {
  const tag = `[${cfg.label}]`;

  // ── Per-instance state
  let bot            = null;
  let busy           = false;
  let schedTimer     = null;
  let afkTimer       = null;
  let isConnected    = false;
  let reconnectCount = 0;
  let failStreak     = 0;
  let lastReason     = 'Starting…';
  let lastConnectAt  = null;
  let nextRetryAt    = null;

  function backoffMs() {
    return Math.round(Math.min(120_000 * Math.pow(1.3, failStreak), 300_000));
  }

  function clearTimer() {
    if (schedTimer) { clearTimeout(schedTimer); clearInterval(schedTimer); schedTimer = null; }
  }

  function scheduleConnect(delayMs) {
    clearTimer();
    nextRetryAt = new Date(Date.now() + delayMs).toLocaleTimeString();
    console.log(`${tag} Next attempt in ${Math.round(delayMs / 1000)}s  (@ ${nextRetryAt})`);
    schedTimer = setTimeout(() => { schedTimer = null; nextRetryAt = null; connect(); }, delayMs);
  }

  function destroyBot() {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    if (!bot) return;
    const b = bot; bot = null; isConnected = false;
    // Attach a no-op error handler before removing listeners so lingering
    // timeouts / keep-alive errors don't bubble up as uncaught exceptions
    try { b.on('error', () => {}); } catch (_) {}
    try { b._client.on('error', () => {}); } catch (_) {}
    try { b.removeAllListeners(); } catch (_) {}
    try { b._client.removeAllListeners(); } catch (_) {}
    try { b.quit(); } catch (_) {}
  }

  function connect() {
    if (busy) return;
    busy = true;
    destroyBot();

    console.log(`${tag} Connecting → ${cfg.ip}:${cfg.port} as ${cfg.name}`);

    try {
      bot = mineflayer.createBot({
        host:    cfg.ip,
        port:    cfg.port,
        username: cfg.name,
        version: cfg.version,
        auth:    'offline',
      });
    } catch (err) {
      console.error(`${tag} createBot threw: ${err.message}`);
      lastReason = 'Create error: ' + err.message;
      busy = false; failStreak++;
      scheduleConnect(backoffMs());
      return;
    }

    // ── Low-level socket
    try {
      if (bot._client.socket) {
        bot._client.socket.once('data', (buf) => {
          const text = buf.toString('utf8').replace(/[^\x20-\x7e]/g, '.');
          console.log(`${tag} Server responded (${buf.length}B): ${text.slice(0, 80)}`);
        });
      }

      bot._client.on('connect', () => console.log(`${tag} TCP connected, handshaking…`));

      bot._client.on('disconnect', (d) => {
        const txt   = (typeof d.reason === 'string' ? d.reason : JSON.stringify(d.reason || d)).slice(0, 150);
        const lower = txt.toLowerCase();
        const isThrottle = lower.includes('throttl') || lower.includes('wait before');
        const isBanned   = lower.includes('banned')  || lower.includes('you are ban');
        console.log(`${tag} Disconnect: ${txt}`);
        busy = false; destroyBot();
        if (isBanned) {
          lastReason = '⛔ BANNED — run /pardon ' + cfg.name + ' in Aternos console';
          console.log(`${tag} ⛔ BANNED. Run: /pardon ${cfg.name} in console, then Force Reconnect.`);
          clearTimer();
        } else if (isThrottle) {
          lastReason = 'Throttled — waiting…';
          failStreak++;
          scheduleConnect(backoffMs());
        } else {
          lastReason = 'Disconnected — rejoining…';
          failStreak = 0;
          scheduleConnect(2_000);
        }
      });
    } catch (e) { console.log(`${tag} Socket listener error: ${e.message}`); }

    // ── Spawn timeout — rejoin in 5s if world didn't load in 45s
    const spawnTimer = setTimeout(() => {
      if (!isConnected) {
        lastReason = 'Spawn timeout — rejoining…';
        console.log(`${tag} Spawn timeout — rejoining in 5s`);
        failStreak = 0;
        busy = false; destroyBot();
        scheduleConnect(5_000);
      }
    }, 45_000);

    // ── Bot events
    bot.once('spawn', () => {
      clearTimeout(spawnTimer);
      failStreak = 0; busy = false; isConnected = true;
      reconnectCount++;
      lastConnectAt = new Date().toLocaleTimeString();
      lastReason = 'Online';
      console.log(`${tag} ✓ Spawned! (#${reconnectCount})`);

      // Anti-AFK: only look around — NO walking (would push bot off the oneblock island)
      if (afkTimer) clearInterval(afkTimer);
      afkTimer = setInterval(() => {
        if (!bot || !isConnected) return;
        try {
          bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4, true);
        } catch (_) {}
      }, 30_000);
    });

    bot.on('login', () => console.log(`${tag} Logged in — waiting for world spawn…`));

    // Auto-respawn so the bot doesn't stay dead if it falls off the island
    bot.on('death', () => {
      console.log(`${tag} Bot died — respawning…`);
      try { bot.respawn(); } catch (_) {}
    });
    bot.on('respawn', () => console.log(`${tag} Respawned ✓`));

    // Accept resource packs + datapacks so server completes configuration handshake
    bot.on('resourcePack', () => {
      console.log(`${tag} Resource/datapack request — accepting`);
      try { bot.acceptResourcePack(); } catch (e) { console.log(`${tag} acceptResourcePack error: ${e.message}`); }
    });

    bot.on('message', (msg) => console.log(`${tag} [Chat] ${msg.toString().slice(0, 120)}`));

    // ── Op command relay — only blackend12 can trigger these ──────────────────
    const OWNER = 'blackend12';
    bot.on('chat', (username, message) => {
      if (username === cfg.name) return;          // ignore the bot's own messages
      if (username !== OWNER) return;             // ignore everyone except the owner
      if (!message.startsWith('!')) return;       // ignore normal chat from owner

      const cmd = message.slice(1).trim();        // strip the leading '!'
      if (!cmd) return;

      console.log(`${tag} [CMD] ${username} → /${cmd}`);
      try {
        bot.chat('/' + cmd);
      } catch (e) {
        console.log(`${tag} [CMD] Failed to run /${cmd}: ${e.message}`);
      }
    });

    bot.on('kicked', (rawReason) => {
      clearTimeout(spawnTimer);
      let msg = ''; try { msg = JSON.stringify(rawReason); } catch (_) { msg = String(rawReason); }
      const lower = msg.toLowerCase();
      const isThrottle = lower.includes('throttl') || lower.includes('wait before');
      const isBanned   = lower.includes('banned')  || lower.includes('ban');
      console.log(`${tag} Kicked: ${msg.slice(0, 120)}`);
      busy = false; destroyBot();
      if (isBanned) {
        lastReason = '⛔ BANNED — run /pardon ' + cfg.name + ' in Aternos console';
        console.log(`${tag} ⛔ BANNED. Run: /pardon ${cfg.name} in console, then Force Reconnect.`);
        clearTimer();
      } else if (isThrottle) {
        lastReason = 'Throttled — waiting…';
        failStreak++;
        scheduleConnect(backoffMs());
      } else {
        lastReason = 'Kicked — rejoining instantly…';
        failStreak = 0;
        scheduleConnect(2_000);
      }
    });

    bot.on('error', (err) => {
      if (!bot) return;
      clearTimeout(spawnTimer);
      console.error(`${tag} Error: ${err.message}`);
      const msg = err.message.toLowerCase();
      const isThrottle  = msg.includes('throttl');
      const isOffline   = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';
      busy = false; destroyBot();
      if (isThrottle) {
        lastReason = 'Throttled — waiting…';
        failStreak++;
        scheduleConnect(backoffMs());
      } else if (isOffline) {
        // Server is fully offline — wait 30s before retrying to avoid IP bans
        lastReason = 'Server offline — retrying in 30s…';
        failStreak = 0;
        scheduleConnect(30_000);
      } else {
        // Dropped connection, ECONNRESET, timeout — rejoin fast
        lastReason = 'Reconnecting…';
        failStreak = 0;
        scheduleConnect(2_000);
      }
    });

    bot.on('end', (reason) => {
      if (!bot) return;
      clearTimeout(spawnTimer);
      const msg = String(reason || 'unknown').slice(0, 80);
      console.log(`${tag} Ended: ${msg}`);
      if (!lastReason.startsWith('⛔') && !lastReason.startsWith('Throttled')) {
        lastReason = 'Reconnecting…';
      }
      busy = false; destroyBot();
      // Only throttle cases get backoff — everything else rejoins in 2s
      if (lastReason.startsWith('Throttled')) {
        scheduleConnect(backoffMs());
      } else {
        failStreak = 0;
        scheduleConnect(2_000);
      }
    });
  }

  // Public API exposed to the web layer
  return {
    cfg,
    getState: () => ({ isConnected, reconnectCount, failStreak, lastReason, lastConnectAt, nextRetryAt }),
    forceReconnect() {
      failStreak = 0; lastReason = 'Manual reconnect…';
      busy = false; destroyBot(); clearTimer();
      scheduleConnect(1_000);
    },
    start() { scheduleConnect(3_000); },
  };
}

// ── Create all bot instances ───────────────────────────────────────────────────
const bots = SERVER_CONFIGS.map(makeBotInstance);

// ── Web dashboard ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function botCard(instance, idx) {
  const { cfg } = instance;
  const { isConnected, reconnectCount, failStreak, lastReason, lastConnectAt, nextRetryAt } = instance.getState();
  const statusClass = isConnected ? 'online' : nextRetryAt ? 'waiting' : 'offline';
  const statusLabel = isConnected ? 'ONLINE'  : nextRetryAt ? 'WAITING'  : 'OFFLINE';
  const isBanned    = lastReason.startsWith('⛔');

  return `
  <div class="card">
    <div class="card-title">🌐 ${cfg.label}</div>
    <div class="badge ${isBanned ? 'banned' : statusClass}">
      <span class="dot"></span>${isBanned ? 'BANNED' : statusLabel}
    </div>
    <div class="row"><span class="label">Bot Name</span><span class="value">${cfg.name}</span></div>
    <div class="row"><span class="label">Server</span><span class="value">${cfg.ip}:${cfg.port}</span></div>
    <div class="row"><span class="label">Version</span><span class="value">${cfg.version}</span></div>
    <div class="row"><span class="label">Last Event</span><span class="value">${lastReason}</span></div>
    ${nextRetryAt ? `<div class="row"><span class="label">Next Attempt</span><span class="value">${nextRetryAt}</span></div>` : ''}
    ${lastConnectAt ? `<div class="row"><span class="label">Last Joined</span><span class="value">${lastConnectAt}</span></div>` : ''}
    <div class="row"><span class="label">Total Joins</span><span class="value">${reconnectCount}</span></div>
    <div class="row"><span class="label">Fail Streak</span><span class="value">${failStreak === 0 ? '—' : failStreak}</span></div>
    <button class="btn" id="btn${idx}" onclick="reconnect(${idx})">⟳ Force Reconnect</button>
    <div class="toast" id="toast${idx}"></div>
  </div>`;
}

app.get('/', (_req, res) => {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
  const upStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AFK Bot Dashboard</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,monospace;background:#0d1117;color:#c9d1d9;
         min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:36px 16px}
    h1{font-size:1.5rem;color:#58a6ff;margin-bottom:4px;letter-spacing:1px}
    .subtitle{color:#6e7681;font-size:.82rem;margin-bottom:24px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:10px;
          width:100%;max-width:480px;padding:20px 22px;margin-bottom:16px}
    .card-title{font-size:.75rem;text-transform:uppercase;letter-spacing:1px;color:#6e7681;margin-bottom:12px}
    .badge{display:inline-flex;align-items:center;gap:7px;font-size:1rem;font-weight:700;
           padding:5px 13px;border-radius:20px;margin-bottom:14px}
    .badge.online {background:#0d2b1d;color:#3fb950;border:1px solid #238636}
    .badge.offline{background:#2d1a1a;color:#f85149;border:1px solid #6e3535}
    .badge.waiting{background:#1c1e10;color:#e3b341;border:1px solid #9e6a03}
    .badge.banned {background:#2d1a1a;color:#f85149;border:1px solid #6e3535}
    .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
    .row{display:flex;justify-content:space-between;align-items:center;
         padding:6px 0;border-bottom:1px solid #21262d;font-size:.85rem}
    .row:last-of-type{border-bottom:none}
    .label{color:#8b949e}
    .value{color:#e6edf3;font-weight:500;text-align:right;max-width:60%;word-break:break-all}
    .btn{width:100%;margin-top:14px;padding:11px;background:#1f6feb;color:#fff;border:none;
         border-radius:8px;font-size:.9rem;font-weight:700;cursor:pointer;
         transition:background .2s,transform .1s;letter-spacing:.4px}
    .btn:hover:not(:disabled){background:#388bfd}
    .btn:active:not(:disabled){transform:scale(.98)}
    .btn:disabled{background:#21262d;color:#484f58;cursor:not-allowed}
    .toast{margin-top:8px;padding:8px 12px;border-radius:6px;font-size:.8rem;display:none}
    .toast.ok {background:#0d2b1d;color:#3fb950;border:1px solid #238636;display:block}
    .toast.err{background:#2d1a1a;color:#f85149;border:1px solid #6e3535;display:block}
    .uptime-card{background:#161b22;border:1px solid #30363d;border-radius:10px;
                 width:100%;max-width:480px;padding:14px 22px;margin-bottom:16px;
                 display:flex;justify-content:space-between;align-items:center;font-size:.85rem}
    .uptime-label{color:#8b949e}
    .uptime-val{color:#e6edf3;font-weight:600}
    .footer{font-size:.72rem;color:#484f58;margin-top:10px}
  </style>
</head>
<body>
  <h1>⛏ AFK Bot Dashboard</h1>
  <p class="subtitle">Keeping your Minecraft servers online</p>

  <div class="uptime-card">
    <span class="uptime-label">Process uptime</span>
    <span class="uptime-val">${upStr}</span>
  </div>

  ${bots.map((b, i) => botCard(b, i)).join('\n')}

  <p class="footer">Auto-refreshes every 8 seconds</p>
  <script>
    setTimeout(() => location.reload(), 8000);
    async function reconnect(idx) {
      const btn = document.getElementById('btn'+idx);
      const toast = document.getElementById('toast'+idx);
      btn.disabled = true; btn.textContent = 'Sending…'; toast.className = 'toast';
      try {
        const r = await fetch('/reconnect/' + idx, { method: 'POST' });
        const d = await r.json();
        toast.className = 'toast ok'; toast.textContent = '✓ ' + d.message;
      } catch(e) {
        toast.className = 'toast err'; toast.textContent = '✗ Could not reach server';
      }
      setTimeout(() => { btn.disabled = false; btn.textContent = '⟳ Force Reconnect'; }, 5000);
    }
  </script>
</body>
</html>`);
});

app.post('/reconnect/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= bots.length) {
    return res.status(400).json({ message: 'Invalid bot index' });
  }
  console.log(`[Web] Manual reconnect triggered for bot ${idx} (${bots[idx].cfg.label})`);
  bots[idx].forceReconnect();
  res.json({ message: `Connecting to ${bots[idx].cfg.label} in 1 second…` });
});

app.listen(WEB_PORT, () => {
  console.log(`[Web] Dashboard on port ${WEB_PORT}`);

  // Self-ping every 4 min to keep Replit awake
  setInterval(() => {
    const req = http.get(`http://localhost:${WEB_PORT}/`, (res) => { res.resume(); });
    req.on('error', () => {});
  }, 4 * 60_000);
});

// ── Start all bots ─────────────────────────────────────────────────────────────
console.log(`[AFK Bot] Starting ${bots.length} bot(s)…`);
bots.forEach(b => b.start());
