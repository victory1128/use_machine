'use strict';

// Zero-dependency machine/NPU sharing server.
// State lives in memory and is persisted to data.json on every change.
// Run: node server.js   (default http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed.json'); // optional preset config
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Data store
// ---------------------------------------------------------------------------

// daily-clear schedule: { enabled: bool, time: "HH:MM", lastCleared: iso|null }
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:MM, 00:00–23:59
function isValidTime(t) { return TIME_RE.test(String(t)); }
function normalizeSchedule(s) {
  s = s && typeof s === 'object' ? s : {};
  const time = isValidTime(s.time) ? String(s.time) : '00:00';
  return {
    enabled: s.enabled === true,
    time,
    lastCleared: typeof s.lastCleared === 'string' ? s.lastCleared : null,
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      machines: Array.isArray(parsed.machines) ? parsed.machines : [],
      names: Array.isArray(parsed.names) ? parsed.names : [],
      schedule: normalizeSchedule(parsed.schedule),
    };
  } catch {
    // No data.json yet: seed from seed.json if it exists, else start empty.
    return seedFromPreset();
  }
}

// seed.json format (all optional):
//   { "machines": [ { "name": "...", "cardCount": 8, "cardLabels": ["NPU0",...], "description": "..." } ] }
function seedFromPreset() {
  const state = { machines: [], names: [], schedule: normalizeSchedule(null) };
  try {
    const raw = fs.readFileSync(SEED_FILE, 'utf8');
    const preset = JSON.parse(raw);
    if (Array.isArray(preset.machines)) {
      for (const def of preset.machines) {
        if (!def || !def.name) continue;
        const count = Math.max(0, Math.min(64, parseInt(def.cardCount, 10) || 0));
        const labels = Array.isArray(def.cardLabels) ? def.cardLabels : null;
        state.machines.push({
          id: uid(),
          name: String(def.name).trim(),
          description: def.description ? String(def.description).trim() : '',
          cards: Array.from({ length: count }, (_, i) => ({
            id: `card-${i}`,
            label: labels && labels[i] ? String(labels[i]) : `NPU${i}`,
            occupancy: null,
          })),
          queue: [],
        });
      }
    }
  } catch {
    // no seed file — that's fine
  }
  return state;
}

function persist() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('persist failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function findMachine(id) {
  return state.machines.find((m) => m.id === id);
}

function nowIso() {
  return new Date().toISOString();
}

// Ensure a machine's structures are well-formed (migrates older data).
function normalizeMachine(m) {
  m.cards = Array.isArray(m.cards) ? m.cards : [];
  m.cards = m.cards.map((c, i) => ({
    id: c.id || `card-${i}`,
    label: typeof c.label === 'string' ? c.label : `NPU${i}`,
    occupancy: c.occupancy || null, // { user, info, since }
  }));
  m.queue = Array.isArray(m.queue) ? m.queue : [];
  m.queue = m.queue.map((q) => ({
    id: q.id || uid(),
    user: q.user || '',
    info: q.info || '',
    since: q.since || nowIso(),
  }));
  return m;
}

state.machines = state.machines.map(normalizeMachine);

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // ~1MB guard
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ __parseError: true });
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent path traversal.
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

// GET /api/state
function getState() {
  return state;
}

// POST /api/machines  { name, cardCount, cardLabels? , description? }
function createMachine(body) {
  if (!body || !body.name || !String(body.name).trim()) {
    return { status: 400, body: { error: 'name required' } };
  }
  const count = Math.max(0, Math.min(64, parseInt(body.cardCount, 10) || 0));
  const labels = Array.isArray(body.cardLabels) ? body.cardLabels : null;
  const machine = normalizeMachine({
    id: uid(),
    name: String(body.name).trim(),
    description: body.description ? String(body.description).trim() : '',
    cards: Array.from({ length: count }, (_, i) => ({
      id: `card-${i}`,
      label: labels && labels[i] ? String(labels[i]) : `NPU${i}`,
      occupancy: null,
    })),
    queue: [],
  });
  state.machines.push(machine);
  persist();
  return { status: 201, body: machine };
}

// PATCH /api/machines/:id  { name?, description? }
function updateMachine(id, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  if (body && body.name) m.name = String(body.name).trim();
  if (body && 'description' in body) m.description = String(body.description).trim();
  persist();
  return { status: 200, body: m };
}

// POST /api/machines/:id/cards  { count }  — add cards to an existing machine
function addCards(id, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const count = Math.max(1, Math.min(64, parseInt(body.count, 10) || 1));
  const start = m.cards.length;
  for (let i = 0; i < count; i++) {
    m.cards.push({
      id: `card-${start + i}`,
      label: `NPU${start + i}`,
      occupancy: null,
    });
  }
  persist();
  return { status: 200, body: m };
}

// DELETE /api/machines/:id
function deleteMachine(id) {
  const idx = state.machines.findIndex((m) => m.id === id);
  if (idx === -1) return { status: 404, body: { error: 'not found' } };
  const [removed] = state.machines.splice(idx, 1);
  persist();
  return { status: 200, body: { ok: true, removed } };
}

// POST /api/machines/:id/occupy  { cardIds:[], user, info }
function occupy(id, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  if (!body || !body.user || !String(body.user).trim()) {
    return { status: 400, body: { error: 'user required' } };
  }
  const cardIds = Array.isArray(body.cardIds) ? body.cardIds : [];
  if (cardIds.length === 0) {
    return { status: 400, body: { error: 'select at least one card' } };
  }
  const user = String(body.user).trim();
  const info = body.info ? String(body.info).trim() : '';
  const since = nowIso();
  const taken = [];
  for (const cid of cardIds) {
    const card = m.cards.find((c) => c.id === cid);
    if (!card) continue;
    if (card.occupancy && card.occupancy.user !== user) {
      return {
        status: 409,
        body: { error: `卡 ${card.label} 已被 ${card.occupancy.user} 占用`, cardId: cid },
      };
    }
    card.occupancy = { user, info, since };
    taken.push(card.id);
  }
  rememberName(user);
  // Remove this user's queue entries (they got their cards).
  m.queue = m.queue.filter((q) => q.user !== user);
  persist();
  return { status: 200, body: m };
}

// POST /api/machines/:id/release  { cardIds?:[], user? }
//   - with cardIds: release those specific cards (only if owned by user)
//   - without cardIds + user: release ALL of that user's cards
function release(id, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const cardIds = Array.isArray(body.cardIds) ? body.cardIds : null;
  const user = body && body.user ? String(body.user).trim() : null;
  let released = 0;
  for (const card of m.cards) {
    if (!card.occupancy) continue;
    if (cardIds && !cardIds.includes(card.id)) continue;
    if (user && card.occupancy.user !== user) continue;
    card.occupancy = null;
    released++;
  }
  persist();
  // Auto-promote: if cards freed and queue non-empty, we just leave it
  // for the UI to surface; promotion is manual to avoid silent reassigns.
  return { status: 200, body: { machine: m, released } };
}

// POST /api/machines/:id/queue  { user, info }
function joinQueue(id, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  if (!body || !body.user || !String(body.user).trim()) {
    return { status: 400, body: { error: 'user required' } };
  }
  const user = String(body.user).trim();
  if (m.queue.some((q) => q.user === user)) {
    return { status: 409, body: { error: '已在队列中' } };
  }
  const info = body.info ? String(body.info).trim() : '';
  const entry = { id: uid(), user, info, since: nowIso() };
  m.queue.push(entry);
  rememberName(user);
  persist();
  return { status: 200, body: m };
}

// POST /api/machines/:id/queue/:entryId/leave  { user }
function leaveQueue(id, entryId, body) {
  const m = findMachine(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const user = body && body.user ? String(body.user).trim() : null;
  const before = m.queue.length;
  m.queue = m.queue.filter((q) => {
    if (q.id !== entryId) return true;
    if (user && q.user !== user) return true; // not owner
    return false;
  });
  persist();
  return { status: 200, body: m };
}

function rememberName(user) {
  if (!user) return;
  if (!state.names.includes(user)) {
    state.names.push(user);
    // keep list bounded
    if (state.names.length > 50) state.names = state.names.slice(-50);
  }
}

// POST /api/reset  — wipe everything (handy in dev)
function resetAll() {
  state = { machines: [], names: [], schedule: normalizeSchedule(state.schedule) };
  persist();
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Daily scheduled clear
// ---------------------------------------------------------------------------

// Clear all occupancies and queues across all machines.
function clearAllOccupancy() {
  for (const m of state.machines) {
    for (const card of m.cards) card.occupancy = null;
    m.queue = [];
  }
  state.schedule.lastCleared = nowIso();
  persist();
}

// Compute the next scheduled clear time (Date) given current time + schedule.
function nextClearDate(schedule, now) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const [h, min] = schedule.time.split(':').map((x) => parseInt(x, 10));
  const next = new Date(nowMs);
  next.setHours(h, min, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
  return next;
}

// Check every minute; if past today's target and not yet cleared today, fire.
let scheduleTimer = null;
function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    const s = state.schedule;
    if (!s || !s.enabled) return;
    const now = new Date();
    const target = new Date(now);
    const [h, min] = s.time.split(':').map((x) => parseInt(x, 10));
    target.setHours(h, min, 0, 0);
    // already cleared today? compare lastCleared date
    const last = s.lastCleared ? new Date(s.lastCleared) : null;
    const lastSameDay = last && last.toDateString() === now.toDateString();
    if (!lastSameDay && now.getTime() >= target.getTime()) {
      clearAllOccupancy();
      console.log(`[schedule] 已定时清空所有占用与队列 (${s.time})`);
    }
  }, 60 * 1000);
}

// GET /api/schedule  -> { enabled, time, lastCleared, nextClear }
function getSchedule() {
  const s = state.schedule;
  const next = s.enabled ? nextClearDate(s, Date.now()).toISOString() : null;
  return { status: 200, body: { ...s, nextClear: next } };
}

// PATCH /api/schedule  { enabled?, time? }
function updateSchedule(body) {
  const s = state.schedule;
  if (body && typeof body.enabled === 'boolean') s.enabled = body.enabled;
  if (body && 'time' in body) {
    if (!isValidTime(body.time)) return { status: 400, body: { error: 'time 格式应为 HH:MM(00:00–23:59)' } };
    s.time = String(body.time);
  }
  persist();
  return getSchedule();
}

// POST /api/schedule/clear-now  -> manually trigger a clear now
function clearNow() {
  clearAllOccupancy();
  return getSchedule();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {

  // ---- API ----
  if (p === '/api/state' && method === 'GET') {
    return sendJson(res, 200, getState());
  }
  if (p === '/api/machines' && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = createMachine(body);
    return sendJson(res, r.status, r.body);
  }
  let m = p.match(/^\/api\/machines\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
      const r = updateMachine(id, body);
      return sendJson(res, r.status, r.body);
    }
    if (method === 'DELETE') {
      const r = deleteMachine(id);
      return sendJson(res, r.status, r.body);
    }
  }
  m = p.match(/^\/api\/machines\/([\w-]+)\/cards$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = addCards(m[1], body);
    return sendJson(res, r.status, r.body);
  }
  m = p.match(/^\/api\/machines\/([\w-]+)\/occupy$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = occupy(m[1], body);
    return sendJson(res, r.status, r.body);
  }
  m = p.match(/^\/api\/machines\/([\w-]+)\/release$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = release(m[1], body);
    return sendJson(res, r.status, r.body);
  }
  m = p.match(/^\/api\/machines\/([\w-]+)\/queue$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = joinQueue(m[1], body);
    return sendJson(res, r.status, r.body);
  }
  m = p.match(/^\/api\/machines\/([\w-]+)\/queue\/([\w-]+)\/leave$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = leaveQueue(m[1], m[2], body);
    return sendJson(res, r.status, r.body);
  }
  if (p === '/api/reset' && method === 'POST') {
    const r = resetAll();
    return sendJson(res, r.status, r.body);
  }
  if (p === '/api/schedule' && method === 'GET') {
    return sendJson(res, 200, getSchedule().body);
  }
  if (p === '/api/schedule' && method === 'PATCH') {
    const body = await readBody(req);
    if (body.__parseError) return sendJson(res, 400, { error: 'invalid json' });
    const r = updateSchedule(body);
    return sendJson(res, r.status, r.body);
  }
  if (p === '/api/schedule/clear-now' && method === 'POST') {
    return sendJson(res, 200, clearNow().body);
  }

  // ---- Static ----
  return serveStatic(req, res);
  } catch (err) {
    console.error('request error:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  机器复用网站 running on http://localhost:${PORT}\n`);
  // Show LAN address so teammates on the same network can connect.
  const lan = getLanIp();
  if (lan) {
    console.log(`  同一局域网/WiFi 下,团队访问: http://${lan}:${PORT}\n`);
  }
  if (state.machines.length === 0) {
    console.log('  (还没有机器,打开页面后点击「添加机器」即可开始)');
  }
  startScheduler(); // start the daily-clear checker
  if (state.schedule && state.schedule.enabled) {
    const next = nextClearDate(state.schedule, Date.now());
    console.log(`  每日定时清空已开启:每天 ${state.schedule.time}(下次 ${next.toLocaleString()})\n`);
  }
});

function getLanIp() {
  try {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch {}
  return null;
}
