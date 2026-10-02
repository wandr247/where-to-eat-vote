const http = require('http'), fs = require('fs'), path = require('path');
const DB = path.join(__dirname, 'data.json');
let state = { restaurants: [
  { id: 1, name: 'Pizza Place', note: 'Wood-fired pizza', votes: 0 },
  { id: 2, name: 'Sushi Spot', note: 'Rolls and sashimi', votes: 0 },
  { id: 3, name: 'Taco Corner', note: 'Casual tacos', votes: 0 } ], nextId: 4, voters: {} };
try { state = JSON.parse(fs.readFileSync(DB)); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(state));
const clients = new Set();
const pub = () => ({ restaurants: state.restaurants });
const broadcast = () => { const m = `data: ${JSON.stringify(pub())}\n\n`; clients.forEach(c => c.write(m)); };
const body = req => new Promise(r => { let b=''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b||'{}')); } catch { r({}); } }); });
const json = (res, o, c=200) => { res.writeHead(c, {'Content-Type':'application/json'}); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) { res.writeHead(200, {'Content-Type':'text/html'}); return res.end(fs.readFileSync(path.join(__dirname,'index.html'))); }
  if (url === '/api/restaurants' && req.method === 'GET') return json(res, pub());
  if (url === '/api/events') { res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'}); res.write(`data: ${JSON.stringify(pub())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return; }
  if (req.method === 'POST' && url === '/api/restaurants') { const b = await body(req); const name = (b.name||'').trim().slice(0,80); if (!name) return json(res,{error:'name required'},400); state.restaurants.push({ id: state.nextId++, name, note: (b.note||'').trim().slice(0,160), votes: 0 }); save(); broadcast(); return json(res, pub()); }
  let m;
  if ((m = url.match(/^\/api\/restaurants\/(\d+)$/))) { const id = +m[1]; const r = state.restaurants.find(x => x.id === id); if (!r) return json(res,{error:'not found'},404);
    if (req.method === 'PUT') { const b = await body(req); if (b.name && b.name.trim()) r.name = b.name.trim().slice(0,80); if (typeof b.note === 'string') r.note = b.note.trim().slice(0,160); save(); broadcast(); return json(res, pub()); }
    if (req.method === 'DELETE') { state.restaurants = state.restaurants.filter(x => x.id !== id); for (const v in state.voters) if (state.voters[v] === id) delete state.voters[v]; save(); broadcast(); return json(res, pub()); } }
  if (req.method === 'POST' && url === '/api/vote') { const b = await body(req); const t = state.restaurants.find(x => x.id === b.id); if (!t || !b.voter) return json(res,{error:'bad vote'},400);
    const prev = state.voters[b.voter]; if (prev === t.id) { /* unvote */ t.votes = Math.max(0,t.votes-1); delete state.voters[b.voter]; }
    else { if (prev) { const p = state.restaurants.find(x => x.id === prev); if (p) p.votes = Math.max(0,p.votes-1); } t.votes++; state.voters[b.voter] = t.id; }
    save(); broadcast(); return json(res, { ...pub(), mine: state.voters[b.voter] || null }); }
  if (url === '/api/mine') { const v = new URL(req.url,'http://x').searchParams.get('voter'); return json(res,{mine: state.voters[v]||null}); }
  if (req.method === 'POST' && url === '/api/reset') { state.restaurants.forEach(r => r.votes = 0); state.voters = {}; save(); broadcast(); return json(res, pub()); }
  res.writeHead(404); res.end('Not found');
}).listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('listening'));
