// Where should we eat? — shared rooms (zero dependencies)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { roomImage } = require('./ogimage');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) { console.error('This app needs Node 22.5 or newer (built-in node:sqlite; on 22.5-22.12 start with --experimental-sqlite). Current:', process.version); process.exit(1); }

const PORT = +process.env.PORT || 3000;
// All persistent storage lives under DATA_DIR (default: the app folder). On Railway mount a volume at /data and set DATA_DIR=/data.
let DATA_DIR_OK = true;
function resolveDataDir() {
  const want = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
  for (const dir of [want, __dirname]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test-' + process.pid);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      if (dir !== want) DATA_DIR_OK = false;
      if (dir !== want) console.error(`DATA_DIR ${want} is not usable; falling back to ${dir} (data will NOT persist across redeploys)`);
      return dir;
    } catch (e) { console.error('data dir not usable:', dir, e.message); }
  }
  return want;
}
const DATA_DIR = resolveDataDir();
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'app.db');
const OLD_ROOMS_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');       // legacy JSON files (auto-imported once)
const OLD_SAVED_FILE = path.join(DATA_DIR, 'saved-lists.json');
const SAVED_TTL_MS = (+process.env.SAVED_TTL_DAYS || 90) * 24 * 60 * 60 * 1000;          // saved lists unused this long are deleted
const TTL_MS = +process.env.ROOM_TTL_MS || 24 * 60 * 60 * 1000;   // room lifetime (24h)
const MAX_ROOMS = +process.env.MAX_ROOMS || 500;
const MAX_RESTAURANTS = 50, MAX_VOTERS = 1000, MAX_CLIENTS_PER_ROOM = 200;
const SPIN_LEAD_MS = 600, SPIN_DURATION_MS = 5000;
const CREATE_LIMIT = +process.env.CREATE_LIMIT || 60;              // rooms per IP per hour
const MAX_SAVED = +process.env.MAX_SAVED || 5000, MAX_SAVED_ITEMS = 50;
const SAVE_LIMIT = +process.env.SAVE_LIMIT || 30;                  // new saved lists / updates per IP per hour
const LOOKUP_LIMIT = +process.env.LOOKUP_LIMIT || 120;             // saved-code lookups per IP per 10 minutes
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';           // no 0 O 1 I L

// ---------- database (SQLite, built into Node) ----------
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL,
  next_id INTEGER NOT NULL DEFAULT 1, angle REAL NOT NULL DEFAULT 0, spin_seq INTEGER NOT NULL DEFAULT 0, spin TEXT
);
CREATE INDEX IF NOT EXISTS rooms_expires ON rooms(expires);
CREATE TABLE IF NOT EXISTS restaurants (
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, id INTEGER NOT NULL, pos INTEGER NOT NULL,
  name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', votes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_code, id)
);
CREATE TABLE IF NOT EXISTS voters (
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, voter TEXT NOT NULL, restaurant_id INTEGER NOT NULL, PRIMARY KEY (room_code, voter)
);
CREATE TABLE IF NOT EXISTS saved_lists (
  code TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL, last_accessed INTEGER NOT NULL, token_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_lists_accessed ON saved_lists(last_accessed);
CREATE TABLE IF NOT EXISTS saved_items (
  code TEXT NOT NULL REFERENCES saved_lists(code) ON DELETE CASCADE, pos INTEGER NOT NULL, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', PRIMARY KEY (code, pos)
);
`);
function tx(fn) {   // run fn inside a transaction; roll back and rethrow on failure
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
const q = {
  roomIns: db.prepare('INSERT OR REPLACE INTO rooms (code, created, expires, next_id, angle, spin_seq, spin) VALUES (?,?,?,?,?,?,?)'),
  roomUpd: db.prepare('UPDATE rooms SET expires = ?, next_id = ?, angle = ?, spin_seq = ?, spin = ? WHERE code = ?'),
  roomDel: db.prepare('DELETE FROM rooms WHERE code = ?'),
  roomsExpired: db.prepare('DELETE FROM rooms WHERE expires <= ?'),
  restDel: db.prepare('DELETE FROM restaurants WHERE room_code = ?'),
  restIns: db.prepare('INSERT INTO restaurants (room_code, id, pos, name, note, votes) VALUES (?,?,?,?,?,?)'),
  votDel: db.prepare('DELETE FROM voters WHERE room_code = ?'),
  votIns: db.prepare('INSERT INTO voters (room_code, voter, restaurant_id) VALUES (?,?,?)'),
  roomsAll: db.prepare('SELECT * FROM rooms'),
  restAll: db.prepare('SELECT * FROM restaurants ORDER BY room_code, pos'),
  votAll: db.prepare('SELECT * FROM voters'),
  roomCount: db.prepare('SELECT COUNT(*) AS n FROM rooms'),
  savedGet: db.prepare('SELECT * FROM saved_lists WHERE code = ?'),
  savedItems: db.prepare('SELECT name, note FROM saved_items WHERE code = ? ORDER BY pos'),
  savedIns: db.prepare('INSERT INTO saved_lists (code, created, updated, last_accessed, token_hash) VALUES (?,?,?,?,?)'),
  savedImport: db.prepare('INSERT OR IGNORE INTO saved_lists (code, created, updated, last_accessed, token_hash) VALUES (?,?,?,?,?)'),
  savedTouch: db.prepare('UPDATE saved_lists SET updated = ?, last_accessed = ? WHERE code = ?'),
  savedAccess: db.prepare('UPDATE saved_lists SET last_accessed = ? WHERE code = ?'),
  savedItemsDel: db.prepare('DELETE FROM saved_items WHERE code = ?'),
  savedItemIns: db.prepare('INSERT INTO saved_items (code, pos, name, note) VALUES (?,?,?,?)'),
  savedCount: db.prepare('SELECT COUNT(*) AS n FROM saved_lists'),
  savedStale: db.prepare('DELETE FROM saved_lists WHERE last_accessed < ?')
};

// Normalise rooms (also used when importing old JSON). Older versions kept a separate wheel item list, which is ignored:
// the wheel always uses the room's restaurants. Never throw on odd/old data.
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
  if (r.voters && typeof r.voters === 'object') for (const [v, id] of Object.entries(r.voters)) if (seen.has(id) && validVoter(v)) voters[v] = id;
  const maxId = restaurants.reduce((m, x) => Math.max(m, x.id), 0);
  const w = r.wheel && typeof r.wheel === 'object' ? r.wheel : {};
  return {
    code, created: Number.isFinite(+r.created) ? +r.created : Date.now(), expires: +r.expires,
    restaurants, nextId: Math.max(Number.isInteger(r.nextId) ? r.nextId : 0, maxId + 1), voters,
    wheel: { angle: Number.isFinite(w.angle) ? w.angle : 0, spin: validSpin(w.spin), spinSeq: Number.isInteger(w.spinSeq) ? w.spinSeq : 0 }
  };
}
function validSpin(sp) {
  return sp && typeof sp === 'object' && ['id', 'start', 'duration', 'from', 'to', 'pick', 'winnerId'].every(k => Number.isFinite(sp[k])) && typeof sp.winner === 'string' && Array.isArray(sp.items) ? sp : null;
}

// write-through: store one room (its row, restaurants and votes) in a single transaction
function writeRoom(room, isNew) {
  const spin = room.wheel.spin ? JSON.stringify(room.wheel.spin) : null;
  if (isNew) q.roomIns.run(room.code, room.created, room.expires, room.nextId, room.wheel.angle, room.wheel.spinSeq, spin);
  else q.roomUpd.run(room.expires, room.nextId, room.wheel.angle, room.wheel.spinSeq, spin, room.code);
  q.restDel.run(room.code); q.votDel.run(room.code);
  room.restaurants.forEach((x, i) => q.restIns.run(room.code, x.id, i, x.name, x.note, x.votes));
  for (const [v, id] of Object.entries(room.voters)) q.votIns.run(room.code, v, id);
}
function persistRoom(room, isNew) {
  try { tx(() => writeRoom(room, isNew)); return true; }
  catch (e) { console.error('room save failed', e.message); return false; }
}

// ---------- load rooms from the database ----------
let rooms = {};   // code -> room (in-memory copy of the database, for live sync)
function loadRooms() {
  const now = Date.now(), byCode = {};
  for (const r of q.roomsAll.all()) {
    if (!(r.expires > now)) continue;
    let spin = null; try { spin = r.spin ? validSpin(JSON.parse(r.spin)) : null; } catch {}
    byCode[r.code] = { code: r.code, created: r.created, expires: r.expires, nextId: r.next_id, restaurants: [], voters: {}, wheel: { angle: r.angle, spin, spinSeq: r.spin_seq } };
  }
  for (const x of q.restAll.all()) if (byCode[x.room_code]) byCode[x.room_code].restaurants.push({ id: x.id, name: x.name, note: x.note, votes: x.votes });
  for (const v of q.votAll.all()) if (byCode[v.room_code]) byCode[v.room_code].voters[v.voter] = v.restaurant_id;
  return byCode;
}
const live = new Map();   // code -> Set of { res, voter }  (not persisted)

// ---------- saved lists (permanent until unused for 90 days) ----------
const SAVED_CODE_RE = /^[A-Z2-9]{6}$/;
const normSavedCode = s => typeof s === 'string' ? s.toUpperCase().replace(/[\s-]/g, '') : '';
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const savedExists = c => !!q.savedGet.get(c);
function newSavedCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 6; k++) c += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
    if (!savedExists(c)) return c;
  }
  return null;
}
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// fetch a saved list { code, created, updated, tokenHash, items } or null
function getSaved(code) {
  const row = q.savedGet.get(code);
  if (!row) return null;
  return { code: row.code, created: row.created, updated: row.updated, tokenHash: row.token_hash, items: q.savedItems.all(code).map(i => ({ name: i.name, note: i.note })) };
}
function writeSavedItems(code, items) {
  q.savedItemsDel.run(code);
  items.forEach((it, i) => q.savedItemIns.run(code, i, it.name, it.note || ''));
}

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
  try { q.roomDel.run(code); } catch (e) { console.error('room delete failed', e.message); }
}
// hourly + at startup: drop expired rooms and saved lists nobody has opened or updated in 90 days
function cleanup() {
  try {
    purge();
    const r1 = q.roomsExpired.run(Date.now()), r2 = q.savedStale.run(Date.now() - SAVED_TTL_MS);
    if (r1.changes || r2.changes) console.log(`cleanup: removed ${r1.changes} expired rooms, ${r2.changes} unused saved lists`);
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch (e) { console.error('cleanup failed', e.message); }
}
setInterval(purge, Math.max(1000, Math.min(30000, TTL_MS / 2)));
setInterval(cleanup, 60 * 60 * 1000);

const getRoom = code => {
  const r = rooms[code];
  if (!r) return null;
  if (r.expires <= Date.now()) { dropRoom(code); return null; }
  return r;
};

// ---------- helpers ----------
const clean = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const validVoter = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v);
// ---------- one-time import of the old JSON files ----------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('could not read', file, e.message); return null; }
}
function migrateOldFiles() {
  const oldRooms = readJson(OLD_ROOMS_FILE), oldSaved = readJson(OLD_SAVED_FILE), now = Date.now();
  if (!oldRooms && !oldSaved) return;
  let nr = 0, ns = 0;
  tx(() => {
    if (oldRooms && oldRooms.rooms && typeof oldRooms.rooms === 'object') {
      for (const [code, r] of Object.entries(oldRooms.rooms)) {
        let n = null; try { n = normRoom(code, r); } catch {}
        if (!n || !(n.expires > now) || q.roomCount.get().n > 100000) continue;
        if (db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code)) continue;
        writeRoom(n, true); nr++;
      }
    }
    if (oldSaved && oldSaved.lists && typeof oldSaved.lists === 'object') {
      for (const [code, l] of Object.entries(oldSaved.lists)) {
        if (!SAVED_CODE_RE.test(code) || !l || typeof l.tokenHash !== 'string' || !Array.isArray(l.items)) continue;
        const items = l.items.map(i => ({ name: clean(i && i.name, 80), note: clean(i && i.note, 160) })).filter(i => i.name).slice(0, MAX_SAVED_ITEMS);
        const created = Number.isFinite(+l.created) ? +l.created : now, updated = Number.isFinite(+l.updated) ? +l.updated : created;
        if (q.savedImport.run(code, created, updated, now, l.tokenHash).changes) { writeSavedItems(code, items); ns++; }
      }
    }
  });
  // only reached if the import committed; keep the originals as *.migrated
  for (const f of [OLD_ROOMS_FILE, OLD_SAVED_FILE]) {
    try { if (fs.existsSync(f)) fs.renameSync(f, f + '.migrated'); } catch (e) { console.error('could not rename', f, e.message); }
  }
  console.log(`migrated old data files: ${nr} rooms, ${ns} saved lists`);
}
try { migrateOldFiles(); } catch (e) { console.error('migration failed (old files left in place, will retry on next start):', e.message); }
rooms = loadRooms();
cleanup();

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
function changed(room) { persistRoom(room, false); broadcast(room); }

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
const sendHtml = (res, name, status = 200, transform) => {
  let body = page(name);
  if (transform) body = Buffer.from(transform(body.toString('utf8')), 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  res.end(body);
};

// ---------- link previews (Open Graph / Twitter cards) ----------
const APP_NAME = 'Spin and Eat';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// absolute origin for the request: honours the proxy's x-forwarded-* headers; https unless running on localhost
function baseUrl(req) {
  const first = v => (v || '').toString().split(',')[0].trim();
  let host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) host = 'localhost';
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:|$)/.test(host);
  let proto = first(req.headers['x-forwarded-proto']).toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = local ? 'http' : 'https';
  return proto + '://' + host;
}
function ogTags({ title, desc, image, url, alt }) {
  return [
    ['property', 'og:site_name', APP_NAME], ['property', 'og:type', 'website'], ['property', 'og:title', title], ['property', 'og:description', desc],
    ['property', 'og:url', url], ['property', 'og:image', image], ['property', 'og:image:type', 'image/png'], ['property', 'og:image:width', '1200'], ['property', 'og:image:height', '630'], ['property', 'og:image:alt', alt],
    ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', title], ['name', 'twitter:description', desc], ['name', 'twitter:image', image], ['name', 'twitter:image:alt', alt],
    ['name', 'description', desc]
  ].map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('\n') + '\n';
}
const injectHead = (html, title, tags) =>
  html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${esc(title)}</title>\n${tags}`);
const DEFAULT_ALT = "Spin and Eat: a colorful spinning wheel and a plate with fork and knife. Can't decide where to eat? Vote or spin.";
function sendLanding(req, res) {
  const base = baseUrl(req);
  const title = APP_NAME + ' – decide where to eat together';
  const tags = ogTags({ title, desc: "Can't decide where to eat? Vote or spin.", image: base + '/og-default.png', url: base + '/', alt: DEFAULT_ALT });
  sendHtml(res, 'index.html', 200, h => injectHead(h, title, tags));
}
function sendRoomPage(req, res, url) {
  const base = baseUrl(req), m = url.match(/^\/r\/(\d{4})(\/wheel)?\/?$/), code = m[1], room = getRoom(code);
  const pageUrl = base + '/r/' + code + (m[2] ? '/wheel' : '');
  let title, desc, image, alt;
  if (room) {
    title = `Join room ${code} on ${APP_NAME}`; desc = 'Vote on where to eat or spin the wheel together.';
    image = `${base}/og/${code}.png`; alt = `Join room ${code} on Spin and Eat`;
  } else {
    title = APP_NAME + ' – decide where to eat together'; desc = "Can't decide where to eat? Vote or spin.";
    image = base + '/og-default.png'; alt = DEFAULT_ALT;
  }
  const tags = ogTags({ title, desc, image, url: pageUrl, alt });
  sendHtml(res, 'room.html', 200, h => injectHead(h, room ? `Room ${code} – ${APP_NAME}` : title, tags));
}
const staticFiles = {};
function sendPng(res, buf, maxAge) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=' + maxAge, 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}
const defaultImage = () => staticFiles.def || (staticFiles.def = fs.readFileSync(path.join(__dirname, 'static', 'og-default.png')));

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
  const list = getSaved(c);
  if (!list) return { status: 404, msg: `No saved list with code ${c}. Check the code and try again.` };
  try { q.savedAccess.run(Date.now(), c); } catch (e) { console.error('last_accessed update failed', e.message); }   // keeps the list from being cleaned up
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

  // pages (HEAD is answered like GET; Node drops the body)
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url === '/' || url === '/index.html') return sendLanding(req, res);
    if (/^\/r\/\d{4}(\/wheel)?\/?$/.test(url)) return sendRoomPage(req, res, url);
    if (url === '/og-default.png') { try { return sendPng(res, defaultImage(), 86400); } catch (e) { res.writeHead(404); return res.end('Not found'); } }
    const om = url.match(/^\/og\/(\d{4})\.png$/);
    if (om) {
      try {
        // unknown / expired rooms get the default card
        return sendPng(res, getRoom(om[1]) ? roomImage(path.join(__dirname, 'static'), om[1]) : defaultImage(), 3600);
      } catch (e) { console.error('og image failed', e.message); res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Image unavailable'); }
    }
    if (url === '/wheel') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (url === '/healthz') {
      try { return json(res, { ok: true, db: 'sqlite', persistent: DATA_DIR_OK, rooms: Object.keys(rooms).length, saved: q.savedCount.get().n }); }
      catch (e) { return json(res, { ok: false, error: 'database unavailable' }, 503); }
    }
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
      restaurants: fromSaved ? freshRestaurants(fromSaved) : [],
      nextId: fromSaved ? MAX_SAVED_ITEMS + 1 : 1, voters: {},
      wheel: { angle: 0, spin: null, spinSeq: 0 }
    };
    if (!persistRoom(rooms[code], true)) { delete rooms[code]; return err(res, 500, 'Could not create a room right now. Please try again.'); }
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
    const prevCode = normSavedCode(b.savedCode), prev = SAVED_CODE_RE.test(prevCode) ? getSaved(prevCode) : null;
    let list, updated = false, token = null;
    try {
      if (prev && typeof b.token === 'string' && b.token.length >= 16 && b.token.length <= 128 && sameHash(prev.tokenHash, hashToken(b.token))) {
        list = prev; updated = true;
        tx(() => { q.savedTouch.run(now, now, prev.code); writeSavedItems(prev.code, items); });
      } else {
        if (q.savedCount.get().n >= MAX_SAVED) return err(res, 503, 'Saved lists are full right now. Please try again later.');
        const c = newSavedCode();
        if (!c) return err(res, 503, 'Could not create a code right now. Please try again.');
        token = crypto.randomBytes(24).toString('base64url');
        list = { code: c };
        tx(() => { q.savedIns.run(c, now, now, now, hashToken(token)); writeSavedItems(c, items); });
      }
    } catch (e) {
      console.error('saved-lists write failed', e.message);
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

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
