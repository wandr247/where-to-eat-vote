// Build-time only (NOT used at runtime): renders the Open Graph images with headless Chrome.
//   node tools/build-og.js     -> static/og-default.png, static/og-room-bg.png, static/og-digits.png
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'static');
const CHROME = process.env.CHROME || 'google-chrome';
const COLORS = ['#e8590c', '#fcc419', '#51cf66', '#339af0', '#845ef7', '#f06595', '#ff922b', '#20c997'];

function wheel(cx, cy, r) {
  const n = COLORS.length, pts = [];
  let s = '';
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    s += `<path d="M${cx} ${cy} L${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${COLORS[i]}" stroke="#fff" stroke-width="${r * 0.025}"/>`;
    const am = (a0 + a1) / 2;
    s += `<circle cx="${(cx + r * 0.68 * Math.cos(am)).toFixed(1)}" cy="${(cy + r * 0.68 * Math.sin(am)).toFixed(1)}" r="${r * 0.07}" fill="#fff" opacity=".85"/>`;
  }
  return `<g><circle cx="${cx}" cy="${cy}" r="${r * 1.06}" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r * 1.06}" fill="none" stroke="#0002" stroke-width="3"/>${s}
    <circle cx="${cx}" cy="${cy}" r="${r * 0.16}" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r * 0.08}" fill="#e8590c"/>
    <path d="M${cx - r * 0.1} ${cy - r * 1.2} L${cx + r * 0.1} ${cy - r * 1.2} L${cx} ${cy - r * 0.9} Z" fill="#c92a2a" stroke="#fff" stroke-width="${r * 0.03}" stroke-linejoin="round"/></g>`;
}
function plate(cx, cy, r) {
  const k = r / 150, fx = cx - r * 1.45, kx = cx + r * 1.45;
  const fork = `<g transform="translate(${fx} ${cy})" fill="#fff"><rect x="${-5 * k}" y="${-10 * k}" width="${10 * k}" height="${150 * k}" rx="${5 * k}"/>
    <rect x="${-26 * k}" y="${-130 * k}" width="${9 * k}" height="${100 * k}" rx="${4.5 * k}"/><rect x="${-4.5 * k}" y="${-130 * k}" width="${9 * k}" height="${100 * k}" rx="${4.5 * k}"/><rect x="${17 * k}" y="${-130 * k}" width="${9 * k}" height="${100 * k}" rx="${4.5 * k}"/>
    <path d="M${-26 * k} ${-35 * k} H${26 * k} V${-10 * k} Q${26 * k} ${12 * k} 0 ${14 * k} Q${-26 * k} ${12 * k} ${-26 * k} ${-10 * k} Z"/></g>`;
  const knife = `<g transform="translate(${kx} ${cy})" fill="#fff"><rect x="${-6 * k}" y="${-10 * k}" width="${12 * k}" height="${150 * k}" rx="${6 * k}"/>
    <path d="M${-14 * k} ${-130 * k} Q${22 * k} ${-120 * k} ${22 * k} ${-60 * k} L${22 * k} ${-5 * k} L${-14 * k} ${-5 * k} Z"/></g>`;
  return `<g>${fork}${knife}<circle cx="${cx}" cy="${cy + 6}" r="${r}" fill="#0003"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.78}" fill="#fff4e6" stroke="#e8590c22" stroke-width="${r * 0.04}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.6}" fill="none" stroke="#e8590c" stroke-width="${r * 0.02}" stroke-dasharray="${r * 0.06} ${r * 0.06}" opacity=".5"/></g>`;
}
const BG = `<defs><radialGradient id="g" cx="25%" cy="20%" r="95%"><stop offset="0" stop-color="#ffa94d"/><stop offset=".55" stop-color="#ff7a1a"/><stop offset="1" stop-color="#e8590c"/></radialGradient></defs><rect width="1200" height="630" fill="url(#g)"/>`;
const FONT = `font-family:'Poppins','Montserrat','Nunito','DejaVu Sans',sans-serif;font-weight:800`;

const defaultSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${BG}
  ${wheel(330, 245, 150)}${plate(850, 258, 112)}
  <text x="600" y="502" text-anchor="middle" style="${FONT};font-size:118px;fill:#fff" >Spin &amp; Eat</text>
  <text x="600" y="576" text-anchor="middle" style="font-family:'Nunito','DejaVu Sans',sans-serif;font-weight:700;font-size:40px;fill:#fff4e6">Can't decide where to eat? Vote or spin.</text></svg>`;

// room card background: branding + empty area on the right where the 4 digit tiles are composited at runtime
const roomSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">${BG}
  ${wheel(240, 225, 112)}${plate(240, 445, 68)}
  <text x="640" y="150" style="${FONT};font-size:92px;fill:#fff">Join room</text>
  <text x="600" y="578" text-anchor="middle" style="font-family:'Nunito','DejaVu Sans',sans-serif;font-weight:700;font-size:36px;fill:#fff4e6" >Spin &amp; Eat · Vote on where to eat or spin the wheel together</text></svg>`;

// digits atlas: 10 tiles, TW x TH each, transparent background
const TW = 130, TH = 190, GAP = 0;
let tiles = '';
for (let d = 0; d < 10; d++) {
  tiles += `<g transform="translate(${d * (TW + GAP)} 0)"><rect x="3" y="9" width="${TW - 6}" height="${TH - 12}" rx="22" fill="#0004"/><rect x="3" y="3" width="${TW - 6}" height="${TH - 12}" rx="22" fill="#fff"/>
  <text x="${TW / 2}" y="${TH * 0.7}" text-anchor="middle" style="${FONT};font-size:142px;fill:#e8590c">${d}</text></g>`;
}
const digitsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${10 * (TW + GAP)}" height="${TH}">${tiles}</svg>`;

function render(name, svg, w, h) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-')), f = path.join(dir, name + '.html');
  fs.writeFileSync(f, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  execFileSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--default-background-color=00000000',
    `--window-size=${w},${h}`, `--screenshot=${path.join(OUT, name + '.png')}`, 'file://' + f], { stdio: 'ignore' });
}
fs.mkdirSync(OUT, { recursive: true });
render('og-default', defaultSvg, 1200, 630);
render('og-room-bg', roomSvg, 1200, 630);
render('og-digits', digitsSvg, 10 * (TW + GAP), TH);
console.log('tile size', TW, TH);
