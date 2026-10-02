// Where should we eat? — shared rooms (zero dependencies)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DB = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TTL_MS = +process.env.ROOM_TTL_MS || 24 * 60 * 60 * 1000;   // room lifetime (24h)
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MAX_RESTAURANTS = 30, MAX_WHEEL = 30, MAX_VOTERS = 1000, MAX_CLIENTS_PER_ROOM = 200;
const SPIN_LEAD_MS = 600, SPIN_DURATION_MS = 5000;
const CREATE_LIMIT = +process.env.CREATE_LIMIT || 60;              // rooms per IP per hour

// ---------- state ----------
let rooms = {};   // code -> room (persisted)
try {
  const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
  if (d && d.rooms && typeof d.rooms === 'object') rooms = d.rooms;
} catch {}
const live = new Map();   // code -> Set of { res, voter }  (not persisted)

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 250);
}
function saveNow() {
  try { fs.writeFileSync(DB + '.tmp', JSON.stringify({ rooms })); fs.renameSync(DB + '.tmp', DB); }
  catch (e) { console.error('save failed', e.message); }
}

function purge() {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (rooms[code].expires <= now) dropRoom(code);
  }
}
function dropRoom(code) {
  const set = live.get(code);
  if (set) for (const c of set) { try { c.res.write('event: expired\ndata: {}\n\n'); c.res.end(); } catch {} }
  live.delete(code);
  delete rooms[code];
  save();
}
setInterval(purge, Math.max(1000, Math.min(30000, TTL_MS / 2)));
purge();

const getRoom = code => {
  const r = rooms[code];
  if (!r) return null;
  if (r.expires <= Date.now()) { dropRoom(code); return null; }
  return r;
};

// ---------- helpers ----------
const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const validVoter = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v);

function snap(room, voter) {
  const set = live.get(room.code);
  return {
    code: room.code, created: room.created, expires: room.expires, now: Date.now(),
    viewers: set ? set.size : 0,
    restaurants: room.restaurants,
    mine: (voter && room.voters[voter]) || null,
    wheel: { items: room.wheel.items, angle: room.wheel.angle, spin: room.wheel.spin }
  };
}
function broadcast(room) {
  const set = live.get(room.code);
  if (!set) return;
  for (const c of set) { try { c.res.write(`data: ${JSON.stringify(snap(room, c.voter))}\n\n`); } catch {} }
}
function changed(room) { save(); broadcast(room); }

function readBody(req) {
  return new Promise(resolve => {
    let b = '', over = false;
    req.on('data', d => { if (over) return; b += d; if (b.length > 16384) { over = true; b = ''; resolve('TOO_BIG'); } });
    req.on('end', () => { if (over) return; try { const o = JSON.parse(b || '{}'); resolve(o && typeof o === 'object' ? o : null); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
const json = (res, o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const err = (res, c, m) => json(res, { error: m }, c);

const pages = {};
const page = name => { // read on each request in dev would be nicer; cache is fine for prod
  if (!pages[name]) pages[name] = fs.readFileSync(path.join(__dirname, name));
  return pages[name];
};
const sendHtml = (res, name, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  res.end(page(name));
};

const createHits = new Map(); // ip -> [timestamps]
function createAllowed(ip) {
  const now = Date.now(), arr = (createHits.get(ip) || []).filter(t => now - t < 3600000);
  if (arr.length >= CREATE_LIMIT) { createHits.set(ip, arr); return false; }
  arr.push(now); createHits.set(ip, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of createHits) if (!a.some(t => now - t < 3600000)) createHits.delete(ip); }, 600000).unref();

function newCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rooms[c]) return c;
  }
  for (let n = 0; n < 10000; n++) { const c = String(n).padStart(4, '0'); if (!rooms[c]) return c; }
  return null;
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const qs = new URL(req.url, 'http://x').searchParams;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

  // pages
  if (req.method === 'GET') {
    if (url === '/' || url === '/index.html') return sendHtml(res, 'index.html');
    if (/^\/r\/\d{4}(\/wheel)?\/?$/.test(url)) return sendHtml(res, 'room.html');
    if (url === '/wheel') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (url === '/healthz') return json(res, { ok: true, rooms: Object.keys(rooms).length });
    if (url === '/api/time') return json(res, { now: Date.now() });
  }

  // create room
  if (url === '/api/rooms' && req.method === 'POST') {
    purge();
    if (!createAllowed(ip)) return err(res, 429, 'Too many rooms created from your network. Try again later.');
    if (Object.keys(rooms).length >= MAX_ROOMS) return err(res, 503, 'The server is full of active rooms right now. Please try again later.');
    const code = newCode();
    if (!code) return err(res, 503, 'No room codes are available right now. Please try again later.');
    const now = Date.now();
    rooms[code] = {
      code, created: now, expires: now + TTL_MS,
      restaurants: [
        { id: 1, name: 'Pizza Place', note: 'Wood-fired pizza', votes: 0 },
        { id: 2, name: 'Sushi Spot', note: 'Rolls and sashimi', votes: 0 },
        { id: 3, name: 'Taco Corner', note: 'Casual tacos', votes: 0 }],
      nextId: 4, voters: {},
      wheel: { items: [], nextId: 1, angle: 0, spin: null, spinSeq: 0 }
    };
    for (const n of ['Pizza', 'Sushi', 'Tacos']) rooms[code].wheel.items.push({ id: rooms[code].wheel.nextId++, name: n });
    save();
    return json(res, { code, expires: rooms[code].expires, now }, 201);
  }

  const m = url.match(/^\/api\/rooms\/(\d{4})(\/.*)?$/);
  if (!m) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const room = getRoom(m[1]);
  if (!room) return err(res, 404, 'Room not found or expired');
  const sub = m[2] || '';

  if (req.method === 'GET' && sub === '') {
    const v = qs.get('voter');
    return json(res, snap(room, validVoter(v) ? v : null));
  }

  if (req.method === 'GET' && sub === '/events') {
    const set = live.get(room.code) || new Set();
    if (set.size >= MAX_CLIENTS_PER_ROOM) return err(res, 503, 'This room is full of viewers');
    const v = qs.get('voter');
    const client = { res, voter: validVoter(v) ? v : null };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    set.add(client); live.set(room.code, set);
    req.on('close', () => { set.delete(client); const r = rooms[room.code]; if (r) broadcast(r); });
    broadcast(room);
    return;
  }

  // everything below mutates
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return err(res, 405, 'Method not allowed');
  const b = await readBody(req);
  if (b === 'TOO_BIG') { res.setHeader('Connection', 'close'); return err(res, 413, 'Request too large'); }
  if (b === null) return err(res, 400, 'Invalid request body');
  const ok = () => json(res, snap(room, validVoter(b.voter) ? b.voter : null));
  const spinning = () => room.wheel.spin && Date.now() < room.wheel.spin.start + room.wheel.spin.duration;
  // once a finished spin exists, editing the wheel clears it (keeps the resting angle)
  const settleSpin = () => { if (room.wheel.spin) { room.wheel.angle = room.wheel.spin.to; room.wheel.spin = null; } };
  let mm;

  // --- restaurants ---
  if (sub === '/restaurants' && req.method === 'POST') {
    const name = clean(b.name, 80);
    if (!name) return err(res, 400, 'Name is required');
    if (room.restaurants.length >= MAX_RESTAURANTS) return err(res, 400, `A room can have at most ${MAX_RESTAURANTS} restaurants`);
    room.restaurants.push({ id: room.nextId++, name, note: clean(b.note, 160), votes: 0 });
    changed(room); return ok();
  }
  if ((mm = sub.match(/^\/restaurants\/(\d+)$/))) {
    const id = +mm[1], r = room.restaurants.find(x => x.id === id);
    if (!r) return err(res, 404, 'Restaurant not found');
    if (req.method === 'PUT') {
      if (b.name !== undefined) { const n = clean(b.name, 80); if (n) r.name = n; }
      if (typeof b.note === 'string') r.note = clean(b.note, 160);
      changed(room); return ok();
    }
    if (req.method === 'DELETE') {
      room.restaurants = room.restaurants.filter(x => x.id !== id);
      for (const v in room.voters) if (room.voters[v] === id) delete room.voters[v];
      changed(room); return ok();
    }
  }
  if (sub === '/vote' && req.method === 'POST') {
    const t = room.restaurants.find(x => x.id === b.id);
    if (!t || !validVoter(b.voter)) return err(res, 400, 'Bad vote');
    const prev = room.voters[b.voter];
    if (prev === undefined && Object.keys(room.voters).length >= MAX_VOTERS) return err(res, 429, 'Too many voters in this room');
    if (prev === t.id) { t.votes = Math.max(0, t.votes - 1); delete room.voters[b.voter]; }   // undo
    else {
      if (prev) { const p = room.restaurants.find(x => x.id === prev); if (p) p.votes = Math.max(0, p.votes - 1); }
      t.votes++; room.voters[b.voter] = t.id;
    }
    changed(room); return ok();
  }
  if (sub === '/reset' && req.method === 'POST') {
    room.restaurants.forEach(r => r.votes = 0); room.voters = {};
    changed(room); return ok();
  }

  // --- wheel ---
  if (sub.startsWith('/wheel') && sub !== '/wheel/spin' && spinning()) return err(res, 409, 'The wheel is spinning — wait for it to stop');
  if (sub === '/wheel/items' && req.method === 'POST') {
    const name = clean(b.name, 40);
    if (!name) return err(res, 400, 'Name is required');
    if (room.wheel.items.length >= MAX_WHEEL) return err(res, 400, `The wheel can have at most ${MAX_WHEEL} choices`);
    settleSpin(); room.wheel.items.push({ id: room.wheel.nextId++, name });
    changed(room); return ok();
  }
  if ((mm = sub.match(/^\/wheel\/items\/(\d+)$/)) && req.method === 'DELETE') {
    const id = +mm[1];
    if (!room.wheel.items.some(x => x.id === id)) return err(res, 404, 'Choice not found');
    settleSpin(); room.wheel.items = room.wheel.items.filter(x => x.id !== id);
    changed(room); return ok();
  }
  if (sub === '/wheel/clear' && req.method === 'POST') {
    settleSpin(); room.wheel.items = [];
    changed(room); return ok();
  }
  if (sub === '/wheel/load' && req.method === 'POST') {
    settleSpin();
    room.wheel.items = room.restaurants.slice(0, MAX_WHEEL).map(r => ({ id: room.wheel.nextId++, name: clean(r.name, 40) }));
    changed(room); return ok();
  }
  if (sub === '/wheel/spin' && req.method === 'POST') {
    if (spinning()) return err(res, 409, 'The wheel is already spinning');
    const items = room.wheel.items, n = items.length;
    if (n < 2) return err(res, 400, 'Add at least 2 choices to spin');
    const TAU = 2 * Math.PI, a = TAU / n, pick = crypto.randomInt(0, n);
    const from = room.wheel.spin ? room.wheel.spin.to % TAU : room.wheel.angle % TAU;
    const jitter = (crypto.randomInt(0, 1000) / 1000 - 0.5) * a * 0.7;
    const target = ((-(pick + 0.5) * a + jitter) % TAU + TAU) % TAU;     // resting angle (mod 2π) with winner under the pointer
    const delta = ((target - from) % TAU + TAU) % TAU;
    const to = from + TAU * (5 + crypto.randomInt(0, 3)) + delta;
    room.wheel.spin = {
      id: ++room.wheel.spinSeq, start: Date.now() + SPIN_LEAD_MS, duration: SPIN_DURATION_MS,
      from, to, pick, winner: items[pick].name, items: items.map(i => i.name)
    };
    changed(room); return ok();
  }

  return err(res, 404, 'Not found');
}).listen(PORT, '0.0.0.0', () => console.log('listening on', PORT));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });
