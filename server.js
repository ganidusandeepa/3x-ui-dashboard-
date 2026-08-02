// Node/Express server for self-hosting the 3x-ui dashboard (e.g. on the same
// VPS as the panel, deployed via Coolify/Docker). This faithfully mirrors the
// Cloudflare Functions in functions/api/[[path]].js, functions/api/stream.js
// and functions/public/stream.js so behavior is identical whether hosted on
// Cloudflare Pages or a Node container.
//
// Config comes from environment variables:
//   PANEL_URL        e.g. http://127.0.0.1:2053   (the local 3x-ui panel)
//   PANEL_USERNAME   panel admin username (used only if PANEL_API_TOKEN is unset)
//   PANEL_PASSWORD   panel admin password (also the dashboard admin token)
//   PANEL_API_TOKEN  panel Settings -> Security -> API Token (Bearer). Preferred
//                    over username/password when set — skips login entirely.
//   PANEL_NODES      optional JSON array of extra node panels to search when a
//                    client isn't found on the master panel, e.g.:
//                    [{"name":"Node1","url":"https://node1.example.com:2053/base","apiToken":"..."}]
//   PORT             HTTP port to listen on (default 8080)
//   METRICS_INTERVAL_MS / METRICS_CACHE_TTL   optional SSE tuning

const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { Agent, setGlobalDispatcher } = require('undici');

// Reuse HTTP connections to the panel (and nodes) instead of a fresh TCP/TLS
// handshake per request. A single client login can make 6+ calls to the same
// panel host back to back — keep-alive turns those into one warm connection.
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32
}));

const app = express();
// Gzip/brotli-negotiated compression for every response (HTML/JS/CSS/JSON) —
// EXCEPT Server-Sent Events. compression() buffers output to build a
// compression window, so an SSE stream never reaches the client: the browser
// opens the connection and then receives nothing at all. (This is invisible to
// curl, which doesn't request gzip unless you pass --compressed.)
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/stream' || req.path === '/public/stream') return false;
    const ct = res.getHeader('Content-Type');
    if (ct && String(ct).includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

const PANEL_URL_RAW = process.env.PANEL_URL || 'http://127.0.0.1:2053';
const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
const ADMIN_USER = process.env.PANEL_USERNAME || 'admin';
const ADMIN_PASS = process.env.PANEL_PASSWORD || 'password';
const PANEL_API_TOKEN = process.env.PANEL_API_TOKEN || null;
const PORT = Number(process.env.PORT || 8080);

// Optional: extra node panels to search when a client isn't found on the
// master panel (e.g. clients added directly on a node's own UI). JSON array:
//   PANEL_NODES=[{"name":"Node1","url":"https://node1.example.com:2053/base","apiToken":"..."}]
// Each node's own API token is required — the master panel stores a
// registered node's token write-only and won't hand it back over the API.
let PANEL_NODES = [];
try {
  const raw = process.env.PANEL_NODES;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) PANEL_NODES = parsed;
  }
} catch (e) { PANEL_NODES = []; }
// Self-hosted on the same VPS as the panel = no Cloudflare subrequest/rate
// limits to work around, so we can poll tighter for a near-real-time feel.
// Override with env vars if you want to ease off (e.g. many concurrent viewers).
const INTERVAL_MS = Math.max(500, Number(process.env.METRICS_INTERVAL_MS || 1500));
const CACHE_TTL_S = Number(process.env.METRICS_CACHE_TTL || 1);

// ---- Session cache (18 min), mirrors the Worker module-level cache ----
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000;

// Tolerate settings/streamSettings returned as objects or JSON strings.
function parseMaybe(v, fallback) {
  if (v == null || v === '') return fallback || {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback || {}; }
}

// Unified client list for one inbound. settings.clients is the source of truth
// for WHICH clients exist (id/uuid, subId, flow, limits) — clientStats only has
// a row once a client has an email + initialized traffic stats, so relying on
// clientStats alone silently drops clients (e.g. added-but-no-traffic-yet, or
// no email). Merge them by email so every configured client is visible, with
// usage overlaid when available.
function inboundClients(inb) {
  const stats = Array.isArray(inb?.clientStats) ? inb.clientStats : [];
  const settings = parseMaybe(inb?.settings);
  const confs = Array.isArray(settings.clients) ? settings.clients : [];
  const byEmail = new Map();

  for (const c of confs) {
    const key = c.email || `__id:${c.id || c.password || Math.random()}`;
    byEmail.set(key, {
      email: c.email || '',
      uuid: c.id || c.uuid || null,
      password: c.password || undefined,
      subId: c.subId || null,
      flow: c.flow,
      enable: c.enable !== false,
      total: Number(c.totalGB || 0),
      expiryTime: Number(c.expiryTime || 0),
      limitIp: c.limitIp,
      up: 0, down: 0,
      inboundId: inb.id,
      hasStats: false
    });
  }

  for (const s of stats) {
    const key = s.email || `__id:${s.id || Math.random()}`;
    const prev = byEmail.get(key) || {};
    byEmail.set(key, {
      ...prev,
      email: s.email || prev.email || '',
      uuid: prev.uuid || s.uuid || null,
      subId: prev.subId || s.subId || null,
      enable: (s.enable !== undefined) ? s.enable : prev.enable,
      up: Number(s.up || 0),
      down: Number(s.down || 0),
      total: (s.total !== undefined ? Number(s.total) : prev.total) || 0,
      expiryTime: Number(s.expiryTime || prev.expiryTime || 0),
      inboundId: inb.id,
      hasStats: true
    });
  }

  return Array.from(byEmail.values());
}
// Maintenance mode — when true, admin sign-in is blocked. Flip to false (and in
// functions/api/[[path]].js + main.js) to re-enable admin access.
const ADMIN_MAINTENANCE = true;

async function getSession(force = false) {
  // If an API token is configured, use it directly — no session/login needed.
  if (PANEL_API_TOKEN) return 'token';

  const now = Date.now();
  if (!force && _session.cookie && now - _session.ts < SESSION_TTL) {
    return _session.cookie;
  }

  // Try 3x-ui 3.6.0+ JSON login first.
  try {
    const r = await fetch(`${PANEL_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    const c = r.headers.get('set-cookie');
    if (c) { _session = { cookie: c, ts: now }; return c; }
  } catch (e) {}

  // Fallback to the legacy form-encoded /login.
  const loginRes = await fetch(`${PANEL_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
    redirect: 'follow'
  });
  const cookie = loginRes.headers.get('set-cookie');
  if (cookie) _session = { cookie, ts: now };
  return cookie;
}

// Build panel-request headers: Bearer token when configured, otherwise the
// session cookie. Used for EVERY fetch to the panel so the token actually
// takes effect everywhere (client lookup, admin proxy, SSE, etc).
function panelHeaders(cookie, extra) {
  return Object.assign({}, extra || {},
    PANEL_API_TOKEN ? { Authorization: `Bearer ${PANEL_API_TOKEN}` } : { Cookie: cookie });
}

// ---- Rolling CPU/RAM history buffer ----
let _sysHistory = [];
const HISTORY_MAX = 24;
function pushHistory(s) {
  try {
    const cpu = Number(s.cpu) || 0;
    const memCur = Number(s.mem?.current) || 0;
    const memTot = Number(s.mem?.total) || 1;
    const ram = memTot > 0 ? Math.round((memCur / memTot) * 100) : 0;
    _sysHistory.push({
      time: new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      cpu: Math.round(Math.min(100, Math.max(0, cpu))),
      ram: Math.min(100, Math.max(0, ram))
    });
    if (_sysHistory.length > HISTORY_MAX) _sysHistory.shift();
  } catch (e) {}
}

// ---- Tiny in-memory TTL cache (replaces Cloudflare caches.default) ----
const _cache = new Map();
async function cachedJson(key, ttlS, producer) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.ts < ttlS * 1000) return hit.value;
  const value = await producer();
  _cache.set(key, { ts: now, value });
  return value;
}

// ---- Client lookup + config-link builder, scoped to ONE panel (master or a
// node) so the same logic can search either. Returns the clientData object,
// or null if this panel doesn't have the client (so the caller can try the
// next one) or is unreachable. ----
async function resolveClientFromPanel(baseUrl, authHeaders, id, sourceLabel) {
  const h = (extra) => Object.assign({}, extra || {}, authHeaders);

  let data;
  try {
    const apiRes = await fetch(`${baseUrl}/panel/api/inbounds/list`, { headers: h() });
    data = await apiRes.json();
  } catch (e) { return null; }
  if (!data || !data.success || !Array.isArray(data.obj)) return null;

  // Search the merged config+stats list, so a client that exists in the
  // inbound's config but has no traffic-stats row yet is still found.
  let foundClient = null;
  let foundInbound = null;
  for (const inb of data.obj) {
    const c = inboundClients(inb).find(x => x.email === id);
    if (c) { foundClient = c; foundInbound = inb; break; }
  }
  if (!foundClient) return null;

  // These five lookups are all independent of each other — fire them
  // concurrently instead of sequentially. On the same VPS as the panel this
  // turns ~5 round trips into effectively 1 (the slowest of the five).
  const normLinks = (obj) => Array.isArray(obj) ? obj.map(x => {
    if (typeof x === 'string') return { remark: '', link: x };
    if (x && typeof x === 'object') return { remark: x.remark || x.name || x.tag || '', link: x.link || x.url || x.uri || '' };
    return null;
  }).filter(x => x && x.link) : [];

  const findOnline = async () => {
    // 3x-ui moved this to /panel/api/clients/*; fall back to legacy /panel/api/inbounds/* on older panels.
    for (const p of ['clients/onlines', 'inbounds/onlines']) {
      try {
        const onRes = await fetch(`${baseUrl}/panel/api/${p}`, {
          method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({})
        });
        const onData = await onRes.json();
        if (onData && onData.success && Array.isArray(onData.obj)) return onData.obj.includes(foundClient.email);
      } catch (e) {}
    }
    return null;
  };

  // Note: client IPs are deliberately NOT fetched here — they were removed
  // from the client-facing response for privacy, so fetching them would just
  // be a wasted round trip on every login.

  const findAllLinks = async () => {
    try {
      const r = await fetch(`${baseUrl}/panel/api/clients/links/${encodeURIComponent(foundClient.email)}`, { headers: h({ Accept: 'application/json' }) });
      const j = await r.json();
      if (j && j.success) return normLinks(j.obj);
    } catch (e) {}
    return [];
  };

  const findSubProtoLinks = async () => {
    if (!foundClient.subId) return [];
    try {
      const r = await fetch(`${baseUrl}/panel/api/clients/subLinks/${encodeURIComponent(foundClient.subId)}`, { headers: h({ Accept: 'application/json' }) });
      const j = await r.json();
      if (j && j.success && Array.isArray(j.obj)) return j.obj.map(x => typeof x === 'string' ? x : (x && (x.link || x.url || x.uri))).filter(Boolean);
    } catch (e) {}
    return [];
  };

  const findLastOnline = async () => {
    try {
      const r = await fetch(`${baseUrl}/panel/api/clients/lastOnline`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({}) });
      const j = await r.json();
      if (j && j.success && j.obj && typeof j.obj === 'object') {
        let ts = Number(j.obj[foundClient.email] || 0);
        if (ts > 0 && ts < 1e12) ts *= 1000;
        return ts || 0;
      }
    } catch (e) {}
    return 0;
  };

  const [isOnline, allLinks, subProtoLinks, lastOnlineTs] = await Promise.all([
    findOnline(), findAllLinks(), findSubProtoLinks(), findLastOnline()
  ]);

  // Config links point at THIS panel's own host — for a node-resolved client
  // that's the node's address (where its Xray inbound actually lives), not
  // the master's.
  let subLink = null, vlessLink = null, vmessLink = null, trojanLink = null, protocol = 'vless';
  try {
    const host = new URL(baseUrl).hostname;
    subLink = foundClient.subId ? `${baseUrl}/sub/${foundClient.subId}` : null;

    if (foundInbound) {
      const stream = parseMaybe(foundInbound.streamSettings);
      const port = foundInbound.port;
      const remark = foundInbound.remark || String(port);
      const network = stream.network || 'tcp';
      const security = stream.security || 'none';
      protocol = (foundInbound.protocol || 'vless').toLowerCase();

      const buildQs = () => {
        let qs = new URLSearchParams();
        qs.set('type', network);
        if (network === 'ws') {
          const ws = stream.wsSettings || {};
          qs.set('path', ws.path || '/');
          qs.set('host', ws.headers?.Host || ws.host || host);
        } else if (network === 'grpc') {
          const grpc = stream.grpcSettings || {};
          qs.set('serviceName', grpc.serviceName || '');
          qs.set('mode', grpc.multiMode ? 'multi' : 'gun');
        } else if (network === 'tcp') {
          const tcp = stream.tcpSettings || {};
          if (tcp.header?.type === 'http') qs.set('headerType', 'http');
        }
        if (security === 'tls') {
          qs.set('security', 'tls');
          const tls = stream.tlsSettings || {};
          qs.set('sni', tls.serverName || host);
          const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
          if (alpn) qs.set('alpn', alpn);
          const fp = tls.settings?.fingerprint || '';
          if (fp) qs.set('fp', fp);
          if (tls.settings?.allowInsecure) qs.set('allowInsecure', '1');
        } else if (security === 'reality') {
          qs.set('security', 'reality');
          const reality = stream.realitySettings || {};
          qs.set('sni', (reality.serverNames || [])[0] || host);
          qs.set('pbk', reality.publicKey || '');
          if (reality.shortIds?.[0]) qs.set('sid', reality.shortIds[0]);
          qs.set('fp', reality.settings?.fingerprint || 'chrome');
        }
        return qs;
      };

      if (protocol === 'vless') {
        const qs = buildQs();
        qs.set('encryption', 'none');
        const settings = parseMaybe(foundInbound.settings);
        const clientConf = (settings.clients || []).find(c => c.email === foundClient.email);
        if (clientConf?.flow) qs.set('flow', clientConf.flow);
        vlessLink = `vless://${foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
      } else if (protocol === 'vmess') {
        const vmessObj = {
          v: '2', ps: `${remark}-${foundClient.email}`, add: host,
          port: String(port), id: foundClient.uuid, aid: '0', scy: 'auto', net: network, type: 'none',
          host: network === 'ws' ? (stream.wsSettings?.headers?.Host || host) : '',
          path: network === 'ws' ? (stream.wsSettings?.path || '/') : '',
          tls: security === 'tls' ? 'tls' : ''
        };
        vmessLink = `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;
      } else if (protocol === 'trojan') {
        const qs = buildQs();
        trojanLink = `trojan://${foundClient.password || foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
      }
    }
  } catch (e) {}

  const configLink = vlessLink || vmessLink || trojanLink || null;

  let subInfo = null;
  if (subLink) {
    try {
      const siRes = await fetch(`${subLink}?format=info`, {
        headers: h({ 'User-Agent': 'ClashforWindows/0.20.0' })
      });
      const sct = siRes.headers.get('content-type') || '';
      if (sct.includes('json')) {
        const sj = await siRes.json().catch(() => null);
        if (sj && (sj.upload !== undefined || sj.download !== undefined)) subInfo = sj;
      }
      if (!subInfo) {
        const hdr = siRes.headers.get('Subscription-Userinfo') || '';
        if (hdr) {
          subInfo = {};
          hdr.split(';').forEach(p => {
            const [k, v] = p.trim().split('=');
            if (k && v !== undefined) subInfo[k.trim()] = Number(v.trim());
          });
        }
      }
    } catch (e) {}
  }

  return { ...foundClient, isOnline, subLink, vlessLink, vmessLink, trojanLink, configLink, protocol, subInfo, allLinks, subProtoLinks, lastOnlineTs, sourceNode: sourceLabel || null };
}

// ---- Shared client lookup (mirrors /api auth 'client') ----
// Searches the master panel first, then falls back to each configured node's
// own panel (see PANEL_NODES) so a client added directly on a node's UI still
// resolves to a full dashboard, exactly like a master-panel client.
async function resolveClient(id) {
  const cookie = await getSession();
  if (!cookie) return { status: 500, body: { success: false, msg: 'Panel Auth Failed' } };

  // Search the master panel and every configured node CONCURRENTLY — same VPS,
  // no rate limits to respect, so the worst case (client only on the last
  // configured node) is one round-trip-chain instead of N sequential ones.
  // Priority (master wins over nodes, nodes in configured order) is still
  // respected once all results are in.
  const targets = [{ baseUrl: PANEL_URL, headers: panelHeaders(cookie), label: null }];
  for (const node of PANEL_NODES) {
    const nodeUrl = String(node?.url || '').replace(/\/$/, '');
    if (nodeUrl && node?.apiToken) {
      targets.push({ baseUrl: nodeUrl, headers: { Authorization: `Bearer ${node.apiToken}` }, label: node.name || nodeUrl });
    }
  }

  const results = await Promise.allSettled(
    targets.map(t => resolveClientFromPanel(t.baseUrl, t.headers, id, t.label))
  );

  let clientData = null;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) { clientData = r.value; break; }
  }

  if (!clientData) return { status: 404, body: { success: false, msg: 'User email not found' } };
  return { status: 200, body: { success: true, role: 'client', clientData } };
}

// ---- Admin auth guard (Bearer <PANEL_PASSWORD>) ----
function isAdmin(req) {
  return req.headers.authorization === `Bearer ${ADMIN_PASS}`;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ success: false, msg: 'Unauthorized' });
  next();
}

// ============================ Middleware ============================
app.use(cors());
// Raw body for the passthrough proxy (preserves multipart boundaries, e.g. importDB)
app.use('/api/xui', express.raw({ type: () => true, limit: '64mb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ============================ Auth ============================
async function handleClientAuth(id, res) {
  try {
    const out = await resolveClient(id);
    return res.status(out.status).json(out.body);
  } catch (e) {
    _session = { cookie: null, ts: 0 };
    return res.status(500).json({ success: false, msg: 'Server connectivity error' });
  }
}

app.post('/api/auth', async (req, res) => {
  const body = req.body || {};
  if (body.type === 'admin') {
    if (ADMIN_MAINTENANCE) {
      return res.status(503).json({ success: false, maintenance: true, msg: 'Admin panel is under maintenance. Please check back later.' });
    }
    if (body.username === ADMIN_USER && body.password === ADMIN_PASS) {
      return res.json({ success: true, role: 'admin' });
    }
    return res.status(401).json({ success: false, msg: 'Invalid admin credentials' });
  }
  if (body.type === 'client') return handleClientAuth((body.id || '').trim(), res);
  return res.status(400).json({ success: false, msg: 'Unsupported' });
});

// Legacy public client-auth endpoint (kept for compatibility)
app.post('/public/auth', (req, res) => {
  const body = req.body || {};
  if (body.type !== 'client') return res.status(400).json({ success: false, msg: 'Unsupported' });
  return handleClientAuth((body.id || '').trim(), res);
});

// ============================ Public ping ============================
// Browser -> this server round-trip probe. Deliberately does NO upstream work
// so the number reflects only the client's own network path; timing /api/ping
// instead would fold the server->panel hop into it.
app.get('/api/rtt', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ t: Date.now() });
});

// This server -> 3x-ui panel latency (measured server-side).
app.get('/api/ping', async (req, res) => {
  const t0 = Date.now();
  let reachable = true;
  try {
    await fetch(`${PANEL_URL}/`, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
  } catch (e) { reachable = false; }
  res.set('Cache-Control', 'no-store').json({ latency: Date.now() - t0, reachable, ts: t0 });
});

// ============================ Settings (admin) ============================
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({ success: true, panelUrl: PANEL_URL, username: ADMIN_USER });
});

// ============================ Generic panel proxy (admin) ============================
app.all('/api/xui/*', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });

    const subPath = req.path.replace(/^\/api\/xui\//, '').replace(/^\/+/, '');
    const targetUrl = `${PANEL_URL}/panel/api/${subPath}`;

    const headers = panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` });
    const ct = req.headers['content-type'];
    if (ct) headers['Content-Type'] = ct; // preserve multipart boundary for importDB

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
    }

    const proxied = await fetch(targetUrl, { method: req.method, headers, body });
    const text = await proxied.text();
    res.status(proxied.status)
      .set('Content-Type', proxied.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================ Aggregated admin endpoints ============================
async function fetchInboundsRaw(cookie) {
  const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
    method: 'GET', headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
  });
  return apiRes.json();
}
// Cached: /api/expiry-alerts, /api/clients and /api/inbounds all pull the same
// master inbounds/list — a page load hits all three within milliseconds, so
// share one upstream fetch instead of three.
function fetchInbounds(cookie) {
  return cachedJson('admin-inbounds', CACHE_TTL_S, () => fetchInboundsRaw(cookie));
}

// ---- Per-panel cached fetchers for the public client SSE stream ----
// Keyed by baseUrl so master and each node cache independently.
async function fetchInboundsForPanel(baseUrl, authHeaders) {
  return cachedJson(`inbounds:${baseUrl}`, CACHE_TTL_S, async () => {
    const apiRes = await fetch(`${baseUrl}/panel/api/inbounds/list`, { headers: authHeaders });
    return apiRes.json();
  });
}
async function fetchOnlinesForPanel(baseUrl, authHeaders) {
  return cachedJson(`onlines:${baseUrl}`, CACHE_TTL_S, async () => {
    for (const p of ['clients/onlines', 'inbounds/onlines']) {
      try {
        const r = await fetch(`${baseUrl}/panel/api/${p}`, {
          method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders), body: JSON.stringify({})
        });
        const j = await r.json();
        if (j && j.success && Array.isArray(j.obj)) return j.obj;
      } catch (e) {}
    }
    return [];
  });
}
// All panels (master + configured nodes) to search, in order.
function panelTargets(cookie) {
  const list = [{ baseUrl: PANEL_URL, headers: panelHeaders(cookie) }];
  for (const node of PANEL_NODES) {
    const nodeUrl = String(node?.url || '').replace(/\/$/, '');
    if (nodeUrl && node?.apiToken) list.push({ baseUrl: nodeUrl, headers: { Authorization: `Bearer ${node.apiToken}` } });
  }
  return list;
}

app.get('/api/expiry-alerts', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
    const alerts = [];
    const now = Date.now();
    const WARN_30 = 30 * 24 * 60 * 60 * 1000;
    if (data && data.obj) {
      data.obj.forEach(inb => {
        (inb.clientStats || []).forEach(c => {
          const exp = Number(c.expiryTime);
          if (exp > 0) {
            const diff = exp - now;
            if (diff <= WARN_30) {
              alerts.push({
                email: c.email, expiryTime: exp,
                daysLeft: Math.ceil(diff / (24 * 60 * 60 * 1000)),
                enable: c.enable, inboundId: inb.id, inboundRemark: inb.remark || String(inb.id)
              });
            }
          }
        });
      });
    }
    alerts.sort((a, b) => a.expiryTime - b.expiryTime);
    res.json({ success: true, obj: alerts });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/system-history', requireAdmin, (req, res) => {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const idx = _sysHistory.length - 10 + i;
    points.push(idx >= 0 ? _sysHistory[idx] : { time: '', cpu: 0, ram: 0 });
  }
  res.json({ success: true, obj: points });
});

app.get('/api/clients', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
    const clients = [];
    if (data && data.obj) {
      data.obj.forEach(inb => {
        // Merged config+stats list so every configured client shows up, not
        // just the ones with a traffic-stats row.
        inboundClients(inb).forEach(c =>
          clients.push({ ...c, inboundRemark: inb.remark || String(inb.id), protocol: inb.protocol }));
      });
    }
    res.json({ success: true, obj: clients });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history', requireAdmin, (req, res) => {
  res.json({
    success: true,
    obj: { dates: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], up: [1, 2, 3, 2, 4, 5, 8], down: [10, 15, 12, 18, 20, 25, 30] }
  });
});

app.get('/api/status', requireAdmin, async (req, res) => {
  try {
    const data = await fetchStatusCached();
    if (data && data.obj) pushHistory(data.obj);
    res.json(data);
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/inbounds', requireAdmin, async (req, res) => {
  try {
    const cookie = await getSession();
    if (!cookie) return res.status(401).json({ success: false, msg: 'Panel Auth Failed' });
    const data = await fetchInbounds(cookie);
    res.json({ success: true, obj: data.obj || data });
  } catch (err) {
    _session = { cookie: null, ts: 0 };
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================ SSE: admin metrics ============================
function sseInit(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
}
function sseSend(res, event, dataObj) {
  const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

// Shared with the plain GET /api/status route below — a page load fires both
// (once for the initial numbers, once to open the stream) within milliseconds
// of each other, so they share one upstream fetch via the 'status' cache key.
const fetchStatusCached = () => cachedJson('status', CACHE_TTL_S, async () => {
  const cookie = await getSession();
  if (!cookie) throw new Error('Panel Auth Failed');
  const apiRes = await fetch(`${PANEL_URL}/panel/api/server/status`, {
    method: 'GET', headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
  });
  const data = await apiRes.json();
  return { success: true, obj: data.obj || data };
});

app.get('/api/stream', requireAdmin, async (req, res) => {
  sseInit(res);
  let closed = false;
  req.on('close', () => { closed = true; });

  sseSend(res, 'hello', { ok: true, intervalMs: INTERVAL_MS, cacheTtlSeconds: CACHE_TTL_S, ts: Date.now() });

  while (!closed) {
    let status;
    try { status = await fetchStatusCached(); } catch (e) { status = { success: false, msg: String(e?.message || e) }; }
    if (closed) break;
    sseSend(res, 'metrics', { ts: Date.now(), status });
    res.write(`: ping ${Date.now()}\n\n`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  try { res.end(); } catch (e) {}
});

// ============================ SSE: public client traffic ============================
app.get('/public/stream', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).json({ success: false, msg: 'Missing id' });

  sseInit(res);
  let closed = false;
  req.on('close', () => { closed = true; });

  sseSend(res, 'hello', { ok: true, intervalMs: INTERVAL_MS, cacheTtlSeconds: CACHE_TTL_S, ts: Date.now() });

  const findClientIn = (inboundsData) => {
    if (!inboundsData || !inboundsData.success || !Array.isArray(inboundsData.obj)) return null;
    let found = null;
    inboundsData.obj.forEach(inb => {
      const c = inboundClients(inb).find(x => String(x.email) === id);
      if (c) found = c;
    });
    return found;
  };

  while (!closed) {
    try {
      const cookie = await getSession();
      if (!cookie) { sseSend(res, 'error', { msg: 'Panel Auth Failed' }); await new Promise(r => setTimeout(r, INTERVAL_MS)); continue; }

      // Search master and every configured node CONCURRENTLY — same fallback
      // priority as the initial /api/auth lookup (master wins), but run in
      // parallel so a node-only client isn't paying for N sequential chains
      // every single tick.
      const targets = panelTargets(cookie);
      const invResults = await Promise.allSettled(
        targets.map(t => fetchInboundsForPanel(t.baseUrl, t.headers).then(inbounds => ({ target: t, inbounds })))
      );

      let client = null, clientPanel = null;
      for (const r of invResults) {
        if (r.status !== 'fulfilled') continue;
        const found = findClientIn(r.value.inbounds);
        if (found) { client = found; clientPanel = r.value.target; break; }
      }

      if (closed) break;
      if (!client) {
        sseSend(res, 'notfound', { id, ts: Date.now() });
      } else {
        // Authoritative online status each tick, from the SAME panel the
        // client was found on, so the pill doesn't flip back to AWAY.
        let isOnline = false;
        try {
          const onlines = await fetchOnlinesForPanel(clientPanel.baseUrl, clientPanel.headers);
          if (Array.isArray(onlines)) isOnline = onlines.includes(client.email);
        } catch (e) {}

        sseSend(res, 'client', {
          ts: Date.now(), email: client.email, down: client.down, up: client.up,
          total: client.total, enable: client.enable, isOnline, lastOnline: client.lastOnline,
          uuid: client.uuid, subId: client.subId, expiryTime: client.expiryTime
        });
      }
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (e) {
      sseSend(res, 'error', { msg: String(e?.message || e) });
    }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
  try { res.end(); } catch (e) {}
});

// ============================ Node diagnostics ============================
// Browser-openable checker for PANEL_NODES + the master panel. Because admin
// login can be in maintenance mode (and browsers don't send Authorization
// headers on a plain GET), it accepts the admin password via ?key=... too:
//   https://<dashboard>/api/nodes-check?key=YOUR_PANEL_PASSWORD
// Add &json=1 for raw JSON. Tokens are masked in the output.
async function probePanel(baseUrl, authHeaders) {
  const started = Date.now();
  try {
    const r = await fetch(`${baseUrl}/panel/api/inbounds/list`, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - started;
    let bodyText = '', json = null;
    try { bodyText = await r.text(); json = JSON.parse(bodyText); } catch (e) {}
    if (!r.ok) {
      const extra = (r.status === 401 || r.status === 403) ? ' — token/credentials rejected'
        : r.status === 404 ? ' — wrong URL or base-path' : '';
      return { ok: false, httpStatus: r.status, ms, error: `HTTP ${r.status}${extra}` };
    }
    if (!json) return { ok: false, httpStatus: r.status, ms, error: 'Non-JSON response (wrong URL / not a 3x-ui API path?)', preview: (bodyText || '').slice(0, 100) };
    if (!json.success) return { ok: false, httpStatus: r.status, ms, error: 'success:false — ' + (json.msg || 'auth or API error') };
    const inbounds = Array.isArray(json.obj) ? json.obj.length : 0;
    let statsClients = 0;   // clients with a traffic-stats row
    let configured = 0;     // clients defined in settings.clients (source of truth)
    if (Array.isArray(json.obj)) json.obj.forEach(i => {
      statsClients += (i.clientStats || []).length;
      const s = parseMaybe(i.settings);
      configured += Array.isArray(s.clients) ? s.clients.length : 0;
    });
    return { ok: true, httpStatus: r.status, ms, inbounds, configured, statsClients, clients: configured };
  } catch (e) {
    const ms = Date.now() - started;
    const msg = String(e?.cause?.code || e?.cause?.message || e?.message || e);
    let hint = '';
    if (/certificate|self-signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i.test(msg)) hint = ' — TLS cert not trusted; set NODE_TLS_REJECT_UNAUTHORIZED=0 or fix the node cert';
    else if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) hint = ' — DNS lookup failed (bad hostname)';
    else if (/ECONNREFUSED/i.test(msg)) hint = ' — connection refused (wrong port / not listening)';
    else if (/timeout|ETIMEDOUT|aborted/i.test(msg)) hint = ' — timed out (unreachable / firewall / hairpin NAT)';
    return { ok: false, ms, error: msg + hint };
  }
}

function maskToken(t) {
  const s = String(t || '');
  if (!s) return '(MISSING)';
  return s.length <= 12 ? `${s.slice(0, 2)}…(${s.length} ch)` : `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} ch)`;
}

app.get('/api/nodes-check', async (req, res) => {
  const key = req.query.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (key !== ADMIN_PASS) {
    return res.status(401).json({ success: false, msg: 'Unauthorized. Open this URL with ?key=YOUR_PANEL_PASSWORD appended.' });
  }

  const rawSet = !!process.env.PANEL_NODES;
  const parseError = rawSet && PANEL_NODES.length === 0
    ? 'PANEL_NODES is set but did NOT parse as a JSON array — check brackets/quotes/commas.' : null;

  // Build targets: master first, then each node.
  const cookie = await getSession().catch(() => null);
  const targets = [];
  targets.push({
    label: 'MASTER',
    url: PANEL_URL,
    auth: PANEL_API_TOKEN ? `API token (${maskToken(PANEL_API_TOKEN)})` : 'cookie login (PANEL_USERNAME/PANEL_PASSWORD)',
    headers: panelHeaders(cookie),
    preError: (!PANEL_API_TOKEN && !cookie) ? 'Panel login failed — check PANEL_USERNAME/PANEL_PASSWORD, or that PANEL_URL is reachable.' : null
  });
  PANEL_NODES.forEach((n, i) => {
    const url = String(n?.url || '').replace(/\/$/, '');
    const tok = String(n?.apiToken || '');
    targets.push({
      label: n?.name || `Node ${i + 1}`,
      url: url || '(missing url)',
      auth: `API token (${maskToken(tok)})`,
      headers: { Authorization: `Bearer ${tok}` },
      preError: (!url || !tok) ? 'Entry is missing "url" or "apiToken".' : null
    });
  });

  const results = await Promise.all(targets.map(async (t) => {
    const base = { label: t.label, url: t.url, auth: t.auth };
    if (t.preError) return { ...base, ok: false, error: t.preError };
    return { ...base, ...(await probePanel(t.url, t.headers)) };
  }));

  const summary = {
    panelNodesEnvSet: rawSet,
    panelNodesParsedCount: PANEL_NODES.length,
    parseError,
    adminMaintenance: ADMIN_MAINTENANCE,
    results
  };

  if (req.query.json) return res.json(summary);
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderNodesCheck(summary));
});

function renderNodesCheck(s) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const card = (r) => {
    const good = r.ok;
    let clientLine = `${r.configured} client(s)`;
    if (good && r.statsClients != null && r.statsClients !== r.configured) {
      clientLine = `${r.configured} configured, ${r.statsClients} with traffic stats`;
    }
    const detail = good
      ? `<div class="ok">✓ OK — ${r.inbounds} inbound(s), ${clientLine}</div>`
      : `<div class="bad">✗ ${esc(r.error)}</div>`;
    const meta = [
      r.httpStatus != null ? `HTTP ${r.httpStatus}` : null,
      r.ms != null ? `${r.ms} ms` : null,
      r.preview ? `body: ${esc(r.preview)}` : null
    ].filter(Boolean).join(' · ');
    return `<div class="c ${good ? 'g' : 'b'}">
      <div class="t">${esc(r.label)}</div>
      <div class="u">${esc(r.url)}</div>
      <div class="a">auth: ${esc(r.auth)}</div>
      ${detail}
      ${meta ? `<div class="m">${meta}</div>` : ''}
    </div>`;
  };
  const banner = s.parseError ? `<div class="warn">${esc(s.parseError)}</div>` : '';
  const mnt = s.adminMaintenance ? `<div class="note">Note: admin sign-in is in maintenance mode. This checker still works via ?key=.</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Node check</title><style>
  body{font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#0b0b0d;color:#e8e8ea;margin:0;padding:16px;line-height:1.5}
  h1{font-size:1.15rem;margin:0 0 4px}
  .sub{color:#9a9aa2;font-size:.82rem;margin-bottom:16px}
  .warn{background:rgba(230,168,23,.15);border:1px solid rgba(230,168,23,.45);color:#e6a817;padding:10px 12px;border-radius:10px;margin-bottom:14px;font-size:.85rem}
  .note{color:#9a9aa2;font-size:.78rem;margin-bottom:14px}
  .c{background:#141418;border:1px solid #26262c;border-radius:14px;padding:14px;margin-bottom:12px}
  .c.g{border-left:4px solid #34d399}.c.b{border-left:4px solid #f26d6d}
  .t{font-weight:700;font-size:.95rem}
  .u{color:#8ab4ff;font-size:.78rem;word-break:break-all;margin:2px 0}
  .a{color:#9a9aa2;font-size:.75rem;margin-bottom:8px}
  .ok{color:#34d399;font-weight:600}.bad{color:#f26d6d;font-weight:600}
  .m{color:#77777f;font-size:.72rem;margin-top:6px;font-family:ui-monospace,monospace}
  </style></head><body>
  <h1>Node connectivity check</h1>
  <div class="sub">PANEL_NODES: ${s.panelNodesEnvSet ? `set, ${s.panelNodesParsedCount} node(s) parsed` : 'not set'}</div>
  ${banner}${mnt}
  ${s.results.map(card).join('')}
  <div class="note">Tokens are masked. A node must use ITS OWN API token (its panel → Settings → Security → API Token), not the master's.</div>
  </body></html>`;
}

// ============================ Static assets + SPA fallback ============================
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      // Always revalidate — it's what references the versioned asset URLs below.
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      // main.js/styles.css/fx.js are loaded via a `?v=NN` cache-busted URL
      // (bumped on every change), so it's safe to cache them for a long time.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/public/')) {
    return res.status(404).json({ success: false, msg: 'Endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`3x-ui dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Proxying panel at ${PANEL_URL} (user: ${ADMIN_USER})`);
});
