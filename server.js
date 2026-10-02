// Where should we eat? — shared rooms (zero dependencies)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
// All persistent storage lives under DATA_DIR (default: the app folder). On Railway mount a volume at /data and set DATA_DIR=/data.
function resolveDataDir() {
  const want = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
  for (const dir of [want, __dirname]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test-' + process.pid);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      if (dir !== want) console.error(`DATA_DIR ${want} is not usable; falling back to ${dir} (data will NOT persist across redeploys)`);
      return dir;
    } catch (e) { console.error('data dir not usable:', dir, e.message); }
  }
  return want;
}
const DATA_DIR = resolveDataDir();
const DB = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');
const SAVED_DB = path.join(DATA_DIR, 'saved-lists.json');
const TTL_MS = +process.env.ROOM_TTL_MS || 24 * 60 * 60 * 1000;   // room lifetime (24h)
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MAX_RESTAURANTS = 50, MAX_VOTERS = 1000, MAX_CLIENTS_PER_ROOM = 200;
const SPIN_LEAD_MS = 600, SPIN_DURATION_MS = 5000;
const CREATE_LIMIT = +process.env.CREATE_LIMIT || 60;              // rooms per IP per hour
const MAX_SAVED = +process.env.MAX_SAVED || 5000, MAX_SAVED_ITEMS = 50;
const SAVE_LIMIT = +process.env.SAVE_LIMIT || 30;                  // new saved lists / updates per IP per hour
const LOOKUP_LIMIT = +process.env.LOOKUP_LIMIT || 120;             // saved-code lookups per IP per 10 minutes
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';           // no 0 O 1 I L

// ---------- state ----------
let rooms = {};   // code -> room (persisted)
try {
  const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
  if (d && d.rooms && typeof d.rooms === 'object') rooms = d.rooms;
} catch {}
// Normalise persisted rooms (older versions kept a separate wheel item list, which is now ignored:
// the wheel always uses the room's restaurants). Never throw on odd/old data.
function normRoom(code, r) {
  if (!r || typeof r !== 'object' || !/^\d{4}$/.test(code) || !Number.isFinite(+r.expires)) return null;
  const seen = new Set(), restaurants = [];
  for (const x of Array.isArray(r.restaurants) ? r.restaurants : []) {
    if (!x || typeof x !== 'object') continue;
    const id = Number.isInteger(x.id) && x.id > 0 ? x.id : null, name = clean(x.name, 80);
    if (id === null || seen.has(id) || !name) continue;
    seen.add(id);
    restaurants.push({ id, name, note: clean(x.note, 160), votes: Number.isFinite(x.votes) && x.votes > 0 ? Math.floor(x.votes) : 0 });
  }
  const voters = {};
  if (r.voters && typeof r.voters === 'object') for (const [v, id] of Object.entries(r.voters)) if (seen.has(id)) voters[v] = id;
  const maxId = restaurants.reduce((m, x) => Math.max(m, x.id), 0);
  const w = r.wheel && typeof r.wheel === 'object' ? r.wheel : {};
  return {
    code, created: Number.isFinite(+r.created) ? +r.created : Date.now(), expires: +r.expires,
    restaurants, nextId: Math.max(Number.isInteger(r.nextId) ? r.nextId : 0, maxId + 1), voters,
    wheel: { angle: Number.isFinite(w.angle) ? w.angle : 0, spin: null, spinSeq: Number.isInteger(w.spinSeq) ? w.spinSeq : 0 }
  };
}
const live = new Map();   // code -> Set of { res, voter }  (not persisted)

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 250);
}
// atomic + durable write: temp file, fsync, rename
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function saveNow() {
  try { writeAtomic(DB, JSON.stringify({ rooms })); }
  catch (e) { console.error('save failed', e.message); }
}

// ---------- saved lists (permanent) ----------
let saved = {};   // CODE -> { code, created, updated, tokenHash, items:[{name,note}] }
try {
  const d = JSON.parse(fs.readFileSync(SAVED_DB, 'utf8'));
  if (d && d.lists && typeof d.lists === 'object') saved = d.lists;
} catch (e) { if (e.code !== 'ENOENT') console.error('could not read saved lists:', e.message); }
function persistSaved() { writeAtomic(SAVED_DB, JSON.stringify({ lists: saved })); }   // throws on failure
const SAVED_CODE_RE = /^[A-Z2-9]{6}$/;
const normSavedCode = s => typeof s === 'string' ? s.toUpperCase().replace(/[\s-]/g, '') : '';
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function newSavedCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 6; k++) c += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    if (!saved[c]) return c;
  }
  return null;
}
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function purge() {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (!rooms[code] || !(rooms[code].expires > now)) dropRoom(code);
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
{ // migrate persisted rooms to the current shape (needs clean() above)
  const out = {};
  for (const [code, r] of Object.entries(rooms)) { try { const n = normRoom(code, r); if (n) out[code] = n; } catch {} }
  rooms = out;
}

function snap(room, voter) {
  const set = live.get(room.code);
  return {
    code: room.code, created: room.created, expires: room.expires, now: Date.now(),
    viewers: set ? set.size : 0,
    restaurants: room.restaurants,
    mine: (voter && room.voters[voter]) || null,
    // the wheel's segments are always the room's restaurants (single shared list)
    wheel: { items: room.restaurants.map(r => ({ id: r.id, name: r.name })), angle: room.wheel.angle, spin: room.wheel.spin }
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

const hits = new Map(); // 'kind:ip' -> [timestamps]
function allowed(kind, ip, limit, windowMs) {
  const key = kind + ':' + ip, now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
const createAllowed = ip => allowed('create', ip, CREATE_LIMIT, 3600000);
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// look up a saved list by user-typed code; returns { list } or { status, msg }
function lookupSaved(ip, raw) {
  if (!allowed('lookup', ip, LOOKUP_LIMIT, 600000)) return { status: 429, msg: 'Too many attempts. Please wait a few minutes and try again.' };
  const c = normSavedCode(raw);
  if (!SAVED_CODE_RE.test(c)) return { status: 400, msg: 'Saved list codes are 6 characters (letters and numbers).' };
  const list = Object.prototype.hasOwnProperty.call(saved, c) ? saved[c] : null;
  if (!list) return { status: 404, msg: `No saved list with code ${c}. Check the code and try again.` };
  return { list };
}
const freshRestaurants = list => list.items.slice(0, MAX_SAVED_ITEMS).map((it, i) => ({ id: i + 1, name: clean(it.name, 80), note: clean(it.note, 160), votes: 0 })).filter(r => r.name);

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
    if (url === '/healthz') return json(res, { ok: true, rooms: Object.keys(rooms).length, saved: Object.keys(saved).length });
    if (url === '/api/time') return json(res, { now: Date.now() });
  }

  // create room
  if (url === '/api/rooms' && req.method === 'POST') {
    purge();
    const b0 = await readBody(req);
    if (b0 === 'TOO_BIG') { res.setHeader('Connection', 'close'); return err(res, 413, 'Request too large'); }
    if (b0 === null) return err(res, 400, 'Invalid request body');
    let fromSaved = null;
    if (b0.saved !== undefined && b0.saved !== '') {
      const f = lookupSaved(ip, b0.saved);
      if (!f.list) return err(res, f.status, f.msg);
      fromSaved = f.list;
    }
    if (!createAllowed(ip)) return err(res, 429, 'Too many rooms created from your network. Try again later.');
    if (Object.keys(rooms).length >= MAX_ROOMS) return err(res, 503, 'The server is full of active rooms right now. Please try again later.');
    const code = newCode();
    if (!code) return err(res, 503, 'No room codes are available right now. Please try again later.');
    const now = Date.now();
    rooms[code] = {
      code, created: now, expires: now + TTL_MS,
      restaurants: fromSaved ? freshRestaurants(fromSaved) : [
        { id: 1, name: 'Pizza Place', note: 'Wood-fired pizza', votes: 0 },
        { id: 2, name: 'Sushi Spot', note: 'Rolls and sashimi', votes: 0 },
        { id: 3, name: 'Taco Corner', note: 'Casual tacos', votes: 0 }],
      nextId: fromSaved ? MAX_SAVED_ITEMS + 1 : 4, voters: {},
      wheel: { angle: 0, spin: null, spinSeq: 0 }
    };
    save();
    return json(res, { code, expires: rooms[code].expires, now, savedCode: fromSaved ? fromSaved.code : undefined }, 201);
  }

  // saved list preview (name + item count only for existence checks)
  const sm = url.match(/^\/api\/saved\/([^/]+)$/);
  if (sm && req.method === 'GET') {
    const f = lookupSaved(ip, decodeURIComponent(sm[1]).slice(0, 20));
    if (!f.list) return err(res, f.status, f.msg);
    return json(res, { code: f.list.code, count: f.list.items.length, updated: f.list.updated });
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
  // list edits are blocked while the wheel is turning (its segments must not change under it)
  const SPIN_MSG = 'The wheel is spinning — wait for it to stop';
  // once a finished spin exists, editing the list clears it (keeps the resting angle)
  const settleSpin = () => { if (room.wheel.spin) { room.wheel.angle = room.wheel.spin.to; room.wheel.spin = null; } };
  let mm;

  // --- saved lists ---
  if (sub === '/save' && req.method === 'POST') {
    const items = room.restaurants.slice(0, MAX_SAVED_ITEMS).map(r => ({ name: clean(r.name, 80), note: clean(r.note, 160) })).filter(r => r.name);
    if (!items.length) return err(res, 400, 'Add at least one restaurant before saving');
    if (!allowed('save', ip, SAVE_LIMIT, 3600000)) return err(res, 429, 'Too many saves from your network. Try again later.');
    const now = Date.now();
    const prevCode = normSavedCode(b.savedCode), prev = SAVED_CODE_RE.test(prevCode) && Object.prototype.hasOwnProperty.call(saved, prevCode) ? saved[prevCode] : null;
    let list, updated = false, token = null, before = null;
    if (prev && typeof b.token === 'string' && b.token.length >= 16 && b.token.length <= 128 && sameHash(prev.tokenHash, hashToken(b.token))) {
      list = prev; updated = true; before = { items: prev.items, updated: prev.updated };
      list.items = items; list.updated = now;
    } else {
      if (Object.keys(saved).length >= MAX_SAVED) return err(res, 503, 'Saved lists are full right now. Please try again later.');
      const c = newSavedCode();
      if (!c) return err(res, 503, 'Could not create a code right now. Please try again.');
      token = crypto.randomBytes(24).toString('base64url');
      list = saved[c] = { code: c, created: now, updated: now, tokenHash: hashToken(token), items };
    }
    try { persistSaved(); }
    catch (e) {
      console.error('saved-lists write failed', e.message);
      if (updated) { list.items = before.items; list.updated = before.updated; } else delete saved[list.code];
      return err(res, 500, 'Could not save right now. Please try again.');
    }
    return json(res, { code: list.code, token, updated, count: items.length });
  }
  if (sub === '/load-saved' && req.method === 'POST') {
    if (spinning()) return err(res, 409, SPIN_MSG);
    const f = lookupSaved(ip, b.code);
    if (!f.list) return err(res, f.status, f.msg);
    settleSpin();
    room.restaurants = freshRestaurants(f.list);
    room.voters = {};
    room.restaurants.forEach(r => { r.id = room.nextId++; });
    changed(room);
    return json(res, { ...snap(room, validVoter(b.voter) ? b.voter : null), loadedCode: f.list.code });
  }

  // --- restaurants ---
  if (sub === '/restaurants' && req.method === 'POST') {
    if (spinning()) return err(res, 409, SPIN_MSG);
    const name = clean(b.name, 80);
    if (!name) return err(res, 400, 'Name is required');
    if (room.restaurants.length >= MAX_RESTAURANTS) return err(res, 400, `A room can have at most ${MAX_RESTAURANTS} restaurants`);
    settleSpin();
    room.restaurants.push({ id: room.nextId++, name, note: clean(b.note, 160), votes: 0 });
    changed(room); return ok();
  }
  if ((mm = sub.match(/^\/restaurants\/(\d+)$/))) {
    const id = +mm[1], r = room.restaurants.find(x => x.id === id);
    if (!r) return err(res, 404, 'Restaurant not found');
    if ((req.method === 'PUT' || req.method === 'DELETE') && spinning()) return err(res, 409, SPIN_MSG);
    if (req.method === 'PUT') {
      settleSpin();
      if (b.name !== undefined) { const n = clean(b.name, 80); if (n) r.name = n; }
      if (typeof b.note === 'string') r.note = clean(b.note, 160);
      changed(room); return ok();
    }
    if (req.method === 'DELETE') {
      settleSpin();
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

  // --- wheel (segments = room.restaurants) ---
  if (sub === '/wheel/spin' && req.method === 'POST') {
    if (spinning()) return err(res, 409, 'The wheel is already spinning');
    const items = room.restaurants, n = items.length;
    if (n < 2) return err(res, 400, 'Add at least 2 restaurants to spin');
    const TAU = 2 * Math.PI, a = TAU / n, pick = crypto.randomInt(0, n);
    const from = room.wheel.spin ? room.wheel.spin.to % TAU : room.wheel.angle % TAU;
    const jitter = (crypto.randomInt(0, 1000) / 1000 - 0.5) * a * 0.7;
    const target = ((-(pick + 0.5) * a + jitter) % TAU + TAU) % TAU;     // resting angle (mod 2π) with winner under the pointer
    const delta = ((target - from) % TAU + TAU) % TAU;
    const to = from + TAU * (5 + crypto.randomInt(0, 3)) + delta;
    room.wheel.spin = {
      id: ++room.wheel.spinSeq, start: Date.now() + SPIN_LEAD_MS, duration: SPIN_DURATION_MS,
      from, to, pick, winner: items[pick].name, winnerId: items[pick].id, items: items.map(i => i.name)
    };
    changed(room); return ok();
  }

  return err(res, 404, 'Not found');
}).listen(PORT, '0.0.0.0', () => console.log('listening on', PORT));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });
