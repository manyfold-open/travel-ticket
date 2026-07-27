// PWA assets for a rendered trip handbook: manifest, service worker, and icons.
//
// Design goals that shaped the choices here:
//   - Self-contained per output dir. Each trip dir (dist/ root AND every
//     dist/trips/<slug>/) gets its own manifest + sw.js + icons with RELATIVE
//     urls, so the same files work when served at `/` (deployed), `/trip/`
//     (studio latest) or `/trips/<dir>/` (studio wallet), and when the dir is
//     zipped and opened locally. Nothing assumes an absolute origin.
//   - No dependencies. Icons are rasterised to PNG with the built-in zlib —
//     no canvas/sharp. Colours mirror docs/design-system.md tokens (no new hex):
//     --night #292a25, --paper #fff8ea, --rail #e3372d, --ink #171713,
//     --rail-deep #9c322b.
//   - Service worker is NETWORK-FIRST for documents (a re-render is always
//     seen when online — no stale-page footgun during `--render-only` dev),
//     CACHE-FIRST for the CDN shell (GSAP + fonts) so an installed handbook
//     opens fully offline after one online visit.
// --- byte helpers (Uint8Array/DataView only, no node: zlib/crypto — Worker-safe) --
function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}
function u32be(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}
function asciiBytes(str) {
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
  return out
}
async function deflate(bytes) {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  writer.write(bytes)
  writer.close()
  const out = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return concatBytes(out)
}
// Small deterministic non-cryptographic hash for the service worker cache id
// — not security sensitive, only needs to change whenever the precache list
// changes (cacheId used to be a sha1 slice; any stable id works).
function shortHash(str) {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = ((h1 * 33) ^ c) >>> 0
    h2 = (((h2 * 33) ^ c) >>> 0) ^ (h2 >>> 5)
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

// --- tokens (mirror docs/design-system.md; not new colours) ---------------------------
const NIGHT = [0x29, 0x2a, 0x25]
const PAPER = [0xff, 0xf8, 0xea]
const RAIL = [0xe3, 0x37, 0x2d]
const INK = [0x17, 0x17, 0x13]
const RAILDEEP = [0x9c, 0x32, 0x2b]
const THEME = '#292a25' // --night: standalone chrome + splash background

// --- icon geometry, normalised to [0,1] -----------------------------------
// A ticket: cream rounded card on a night field, red rail stripe down the
// left, a barcode in the main panel, a perforation of punched holes, and a
// round postmark on the stub. Content sits inside the maskable safe zone
// (~inner 80%) so one 512 icon serves both `any` and `maskable`.
const TICKET = { x0: 0.23, y0: 0.19, x1: 0.77, y1: 0.81, r: 0.06 }
const PERF_X = 0.615
const BAND_X = 0.335
const BARS = [[0.375, 0.028], [0.418, 0.018], [0.452, 0.034], [0.500, 0.018], [0.536, 0.030]]

const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by)

const inRoundRect = (x, y, { x0, y0, x1, y1, r }) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const ix0 = x0 + r, ix1 = x1 - r, iy0 = y0 + r, iy1 = y1 - r
  if (x >= ix0 && x <= ix1) return true
  if (y >= iy0 && y <= iy1) return true
  const cx = x < ix0 ? ix0 : ix1
  const cy = y < iy0 ? iy0 : iy1
  return dist2(x, y, cx, cy) <= r * r
}

// Topmost layer colour at a normalised point.
function sampleColor(nx, ny) {
  if (!inRoundRect(nx, ny, TICKET)) return NIGHT
  // perforation: punched holes down the stub divider (cut through to night)
  for (let cy = 0.265; cy <= 0.75; cy += 0.0685) {
    if (dist2(nx, ny, PERF_X, cy) < 0.0165 * 0.0165) return NIGHT
  }
  // postmark ring on the stub
  const d = Math.sqrt(dist2(nx, ny, 0.692, 0.345))
  if (d <= 0.062 && d >= 0.045) return RAILDEEP
  // rail stripe down the left edge
  if (nx < BAND_X) return RAIL
  // barcode in the main panel
  if (nx >= 0.37 && nx <= 0.585 && ny >= 0.62 && ny <= 0.745) {
    for (const [bx, bw] of BARS) if (nx >= bx && nx < bx + bw) return INK
  }
  return PAPER
}

// Rasterise the icon to an RGBA buffer with SSx supersampling for smooth edges.
function iconRgba(size) {
  const ss = 3
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size
          const ny = (y + (sy + 0.5) / ss) / size
          const c = sampleColor(nx, ny)
          r += c[0]; g += c[1]; b += c[2]
        }
      }
      const n = ss * ss
      const o = (y * size + x) * 4
      rgba[o] = Math.round(r / n)
      rgba[o + 1] = Math.round(g / n)
      rgba[o + 2] = Math.round(b / n)
      rgba[o + 3] = 255 // fully opaque: night fills the whole canvas
    }
  }
  return rgba
}

// --- minimal PNG encoder (RGBA, 8-bit) -------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const typeBuf = asciiBytes(type)
  const crc = u32be(crc32(concatBytes([typeBuf, data])))
  return concatBytes([u32be(data.length), typeBuf, data, crc])
}
async function encodePng(size, rgba) {
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, size, false); ihdrView.setUint32(4, size, false)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // depth 8, RGBA, no interlace
  const stride = size * 4
  const raw = new Uint8Array((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  const idat = await deflate(raw)
  return concatBytes([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))])
}
const iconPng = (size) => encodePng(size, iconRgba(size))

// --- vector favicon (same motif, hand-authored) ----------------------------
function iconSvg() {
  const holes = []
  for (let cy = 0.265; cy <= 0.75; cy += 0.0685) holes.push(`<circle cx="${(PERF_X * 100).toFixed(1)}" cy="${(cy * 100).toFixed(1)}" r="1.6" fill="#292a25"/>`)
  const bars = BARS.map(([bx, bw]) => `<rect x="${(bx * 100).toFixed(1)}" y="62" width="${(bw * 100).toFixed(1)}" height="12.5" fill="#171713"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="#292a25"/>` +
    `<rect x="23" y="19" width="54" height="62" rx="6" fill="#fff8ea"/>` +
    `<path d="M23 25a6 6 0 0 1 6-6h4.5v62H29a6 6 0 0 1-6-6z" fill="#e3372d"/>` +
    bars + holes +
    `<circle cx="69.2" cy="34.5" r="5.3" fill="none" stroke="#9c322b" stroke-width="1.7"/>` +
    `</svg>`
}

// --- manifest --------------------------------------------------------------
function manifestJson({ name, short, description, language = 'en-GB' }) {
  return JSON.stringify({
    id: './',
    name,
    short_name: short,
    description,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait-primary',
    lang: language,
    dir: 'ltr',
    theme_color: THEME,
    background_color: THEME,
    icons: [
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, null, 2)
}

// --- service worker --------------------------------------------------------
// cacheId changes whenever the precache list changes, so activate() drops the
// stale cache. Network-first for documents keeps re-renders visible online.
function serviceWorkerJs(pages, cacheId) {
  const core = JSON.stringify(['./', ...pages])
  return `// Auto-generated by pipeline/pwa.mjs — trip handbook offline shell.
const CACHE = 'tt::${cacheId}';
const CORE = ${core};
const CDN = ['https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('tt::')).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = CDN.some((h) => url.href.startsWith(h));

  // Documents: network-first (fresh when online), fall back to cache offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, net.clone()).catch(() => {});
        return net;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets + CDN shell (GSAP, fonts): cache-first, revalidate.
  if (isCdn || url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const fetching = fetch(req).then((net) => {
        // Clone SYNCHRONOUSLY here — deferring the clone into the caches.open
        // callback races with respondWith consuming the body ('body already
        // used' → put silently rejects and nothing caches).
        if (net) {
          const copy = net.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return net;
      }).catch(() => null);
      return cached || (await fetching) || Response.error();
    })());
  }
});
`
}

// --- public API ------------------------------------------------------------
// Names for the manifest, derived from the itinerary in render.mjs and passed
// in so we don't re-derive cover fields here.
export function pwaNames(itinerary, { destinationTop, destinationAccent, language = 'en-GB' }) {
  const top = (destinationTop || itinerary.destination || 'Trip').trim()
  const accent = (destinationAccent || '').trim()
  const name = (accent && accent !== 'Itinerary' && accent !== '行程' ? `${top} ${accent}` : top) || (language === 'zh-CN' ? '旅行票据' : 'Trip Ticket')
  const short = (top.split(/[\s·,，:：]/)[0] || 'Trip').slice(0, 12)
  return { name, short }
}

// Pure: no fs, no node: imports. Returns a Map of path (relative to the
// trip's outDir) → content. Async because PNG icon encoding deflates via
// CompressionStream.
export async function buildPwaAssetFiles({ name, short, description, language = 'en-GB' }, pages, extraAssets = []) {
  // extraAssets 空時 hash 輸入與舊版相同結構 → cacheId 只在清單真的變動時變。
  const hashInput = extraAssets.length ? [name, pages, extraAssets] : [name, pages]
  const cacheId = shortHash(JSON.stringify(hashInput))
  const [icon192, icon512] = await Promise.all([iconPng(192), iconPng(512)])
  return new Map([
    ['manifest.webmanifest', manifestJson({ name, short, description, language })],
    ['sw.js', serviceWorkerJs([...pages, ...extraAssets], cacheId)],
    ['icon.svg', iconSvg()],
    ['icon-192.png', icon192],
    ['icon-512.png', icon512],
  ])
}
