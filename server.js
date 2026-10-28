'use strict';
const path = require('path');
const express = require('express');
const compression = require('compression');
const db = require('./lib/db');
const auth = require('./lib/auth');
const store = require('./lib/store');
const ai = require('./lib/ai');
const azure = require('./lib/azure');

if (String(process.env.SESSION_SECRET || '').length < 32) { console.error('Falta SESSION_SECRET (mínimo 32 caracteres aleatorios).'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression({ filter: (req, res) => req.path === '/api/stream' ? false : compression.filter(req, res) }));

/* ---------- cabeceras de seguridad ---------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

const bigJson = express.json({ limit: '16mb' });
const smallJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/ai' || req.path === '/api/admin/restore') ? bigJson(req, res, next) : smallJson(req, res, next));

/* Protección CSRF: las escrituras solo se aceptan desde nuestro propio origen. */
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'origen' }); } catch (e) { return res.status(403).json({ error: 'origen' }); } }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'json' });
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e && e.status) return res.status(e.status).json({ error: e.msg || 'error' });
  console.error(e); res.status(500).json({ error: 'Error interno.' });
});

/* ---------- públicos ---------- */
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/vendor', express.static(path.join(__dirname, 'public/vendor'), { maxAge: '7d', immutable: true }));
app.get('/base.css', (req, res) => res.sendFile(path.join(__dirname, 'public/base.css')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/login', (req, res) => res.redirect('/login.html'));

app.post('/api/login', wrap(async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().toLowerCase().slice(0, 80);
  const pw = String((req.body && req.body.password) || '').slice(0, 200);
  const k1 = 'u:' + username, k2 = 'i:' + req.ip;
  const lock = Math.max(auth.lockedFor(k1), auth.lockedFor(k2));
  if (lock) return res.status(429).json({ error: 'Demasiados intentos. Espera ' + lock + ' min e inténtalo de nuevo.' });
  const r = await db.q('SELECT * FROM users WHERE username=$1', [username]);
  const u = r.rows[0];
  const ok = u ? auth.verifyPassword(pw, u.pass_hash) : (auth.verifyPassword(pw, 'scrypt$00$00'), false);
  if (!ok || !u.active) { auth.noteFail(k1, 6); auth.noteFail(k2, 40); return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); }
  auth.clearFails(k1);
  await db.q('UPDATE users SET last_login=now() WHERE id=$1', [u.id]);
  auth.setSession(res, u);
  res.json({ ok: true, mustChange: u.must_change });
}));
app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

/* ---------- puerta de acceso ---------- */
app.use(wrap(async (req, res, next) => {
  const u = await auth.sessionUser(req).catch(e => { console.error(e); return null; });
  if (!u) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesión vencida. Vuelve a iniciar sesión.' });
    return res.redirect('/login.html');
  }
  req.user = u;
  if (u.must_change && req.path !== '/api/password' && req.path !== '/api/me' && req.path !== '/api/logout') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Debes cambiar tu contraseña.' });
    return res.redirect('/login.html?change=1');
  }
  if (req.path !== '/api/stream') auth.setSession(res, u);   // sesión deslizante
  next();
}));
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores.' });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));
app.get('/admin.html', (req, res) => req.user.role === 'admin' ? res.sendFile(path.join(__dirname, 'public/admin.html')) : res.redirect('/'));

async function backupInfo() {
  const r = await db.q("SELECT value, updated_at FROM meta WHERE key='last_backup'");
  const t = r.rows[0] ? new Date(r.rows[0].updated_at) : null;
  const days = t ? Math.floor((Date.now() - t.getTime()) / 86400000) : null;
  return { last: t ? t.toISOString() : null, days, due: days == null || days >= 30 };
}
app.get('/api/me', wrap(async (req, res) => {
  const u = req.user;
  res.json({ user: { username: u.username, name: u.name, role: u.role, mustChange: u.must_change }, ai: { enabled: ai.enabled(), model: ai.enabled() ? ai.MODEL : null },
    azure: { enabled: azure.enabled(), org: azure.enabled() ? azure.org() : null, project: azure.defaultProject() || null, syncMinutes: azure.syncMinutes() },
    backup: u.role === 'admin' ? await backupInfo() : null });
}));
app.post('/api/password', wrap(async (req, res) => {
  const { current, next: np } = req.body || {};
  const r = await db.q('SELECT * FROM users WHERE id=$1', [req.user.id]); const u = r.rows[0];
  if (!auth.verifyPassword(String(current || ''), u.pass_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  const bad = auth.passwordProblem(np); if (bad) return res.status(400).json({ error: bad });
  if (np === current) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta.' });
  const n = (await db.q('UPDATE users SET pass_hash=$2, pv=pv+1, must_change=false WHERE id=$1 RETURNING *', [u.id, auth.hashPassword(np)])).rows[0];
  auth.setSession(res, n); res.json({ ok: true });
}));

/* ---------- documentos + tiempo real (SSE) ---------- */
const clients = new Set();
function broadcast(ev) { const s = 'data: ' + JSON.stringify(ev) + '\n\n'; clients.forEach(c => { try { c.write(s); } catch (e) {} }); }
app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
});
/* azure_bugs solo se lee desde el navegador; únicamente el servidor lo escribe (al sincronizar con Azure DevOps). */
const colOk = (req, res, next) => {
  const readOnly = req.params.col === 'azure_bugs' && req.method === 'GET';
  const ok = (store.COLS.includes(req.params.col) || readOnly) && (!req.params.id || store.ID_RE.test(req.params.id));
  return ok ? next() : res.status(400).json({ error: 'Colección o id inválido.' });
};

app.get('/api/docs/:col', colOk, wrap(async (req, res) => res.json(await store.listDocs(req.params.col))));
app.post('/api/docs/:col', colOk, wrap(async (req, res) => {
  const id = store.newId(), d = await store.setDoc(req.params.col, id, req.body, req.user.name);
  broadcast({ op: 'set', col: req.params.col, id, data: d.data, version: d.version }); res.json({ id, version: d.version });
}));
app.put('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  const d = await store.setDoc(req.params.col, req.params.id, req.body, req.user.name);
  broadcast({ op: 'set', col: req.params.col, id: d.id, data: d.data, version: d.version }); res.json({ id: d.id, version: d.version });
}));
app.patch('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  const d = await store.mergeDoc(req.params.col, req.params.id, req.body, req.user.name);
  broadcast({ op: 'set', col: req.params.col, id: d.id, data: d.data, version: d.version }); res.json({ id: d.id, version: d.version, data: d.data });
}));
app.delete('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  await store.delDoc(req.params.col, req.params.id);
  broadcast({ op: 'del', col: req.params.col, id: req.params.id });
  if (req.params.col === 'projects') { await store.delDoc('azure_bugs', req.params.id); broadcast({ op: 'del', col: 'azure_bugs', id: req.params.id }); }
  res.json({ ok: true });
}));

/* ---------- Azure DevOps (solo lectura) ---------- */
const azErr = (res, e) => res.status((e && e.status) || 502).json({ error: (e && e.msg) || 'No se pudo consultar Azure DevOps.', code: (e && e.code) || 'azure' });
app.post('/api/azure/test', wrap(async (req, res) => {
  if (!azure.enabled()) return res.status(503).json({ error: 'La conexión con Azure DevOps no está configurada en el servidor.', code: 'azure_disabled' });
  if (!azure.rateOk(req.user.id)) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espera unos minutos.', code: 'rate_limited' });
  try { res.json(await azure.preview(req.body)); } catch (e) { azErr(res, e); }
}));
app.post('/api/azure/sync/:id', wrap(async (req, res) => {
  if (!store.ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (!azure.enabled()) return res.status(503).json({ error: 'La conexión con Azure DevOps no está configurada en el servidor.', code: 'azure_disabled' });
  const force = !!(req.body && req.body.force);
  if (force && !azure.rateOk(req.user.id)) return res.status(429).json({ error: 'Demasiadas sincronizaciones seguidas. Espera unos minutos.', code: 'rate_limited' });
  try { res.json(await azure.syncProject(req.params.id, req.user.name, { force, broadcast })); } catch (e) { azErr(res, e); }
}));

/* ---------- IA (Gemini) ---------- */
app.post('/api/ai', wrap(async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ code: 'sampling_disabled' });
  if (!ai.rateOk(req.user.id)) return res.status(429).json({ code: 'rate_limited' });
  const { prompt, images } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ code: 'bad_request' });
  try { res.json({ data: await ai.askJson(prompt, images) }); }
  catch (e) { res.status(e && e.code === 'rate_limited' ? 429 : 502).json({ code: (e && e.code) || 'upstream' }); }
}));

app.post('/api/ai/test', adminOnly, wrap(async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ ok: false, code: 'sampling_disabled' });
  try { const d = await ai.askJson('Responde solo con este JSON: {"ok": true}'); res.json({ ok: !!(d && d.ok), model: ai.MODEL }); }
  catch (e) { res.status(502).json({ ok: false, code: (e && e.code) || 'upstream', model: ai.MODEL }); }
}));

/* ---------- administración ---------- */
const USER_COLS = 'id, username, name, role, must_change, active, created_at, last_login';
app.get('/api/admin/users', adminOnly, wrap(async (req, res) => res.json((await db.q(`SELECT ${USER_COLS} FROM users ORDER BY username`)).rows)));
app.post('/api/admin/users', adminOnly, wrap(async (req, res) => {
  const b = req.body || {}, username = String(b.username || '').trim().toLowerCase(), name = String(b.name || '').trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Usuario: 3–40 caracteres (letras minúsculas, números, punto, guion).' });
  if (!name) return res.status(400).json({ error: 'Escribe el nombre completo.' });
  const bad = auth.passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
  const role = b.role === 'admin' ? 'admin' : 'analista';
  try { await db.q('INSERT INTO users(username,name,role,pass_hash,must_change) VALUES ($1,$2,$3,$4,true)', [username, name, role, auth.hashPassword(b.password)]); }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe.' }); throw e; }
  res.json({ ok: true });
}));
app.patch('/api/admin/users/:id', adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), b = req.body || {};
  const cur = (await db.q('SELECT * FROM users WHERE id=$1', [id])).rows[0]; if (!cur) return res.status(404).json({ error: 'No existe.' });
  const demoting = cur.role === 'admin' && ((b.role && b.role !== 'admin') || b.active === false);
  if (demoting) {
    const n = (await db.q("SELECT count(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1", [id])).rows[0].n;
    if (!n) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo.' });
  }
  const sets = [], vals = [id];
  const add = (c, v) => { vals.push(v); sets.push(c + '=$' + vals.length); };
  if (typeof b.name === 'string' && b.name.trim()) add('name', b.name.trim());
  if (b.role === 'admin' || b.role === 'analista') add('role', b.role);
  if (typeof b.active === 'boolean') { add('active', b.active); sets.push('pv=pv+1'); }
  if (b.password) {
    const bad = auth.passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
    add('pass_hash', auth.hashPassword(b.password)); add('must_change', true); sets.push('pv=pv+1');
  }
  if (sets.length) await db.q('UPDATE users SET ' + sets.join(', ') + ' WHERE id=$1', vals);
  res.json({ ok: true });
}));
app.get('/api/admin/backup', adminOnly, wrap(async (req, res) => {
  const out = { app: 'quqi-qa', formato: 1, exportadoEn: new Date().toISOString(), exportadoPor: req.user.username, collections: await store.exportAll() };
  res.setHeader('Content-Disposition', 'attachment; filename="quqi-qa-respaldo-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(out);
}));
app.get('/api/admin/backup-data', adminOnly, wrap(async (req, res) => res.json(await store.exportAll())));
app.post('/api/admin/backup-done', adminOnly, wrap(async (req, res) => {
  await db.q("INSERT INTO meta(key,value) VALUES ('last_backup', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [JSON.stringify({ por: req.user.username })]);
  res.json(await backupInfo());
}));
app.post('/api/admin/restore', adminOnly, wrap(async (req, res) => {
  const b = req.body || {}; const cols = b.collections || ((b.app === 'quqi-qa' || b.app === 'qa-certifica') ? b.collections : null);
  if (!cols || typeof cols !== 'object') return res.status(400).json({ error: 'El archivo no tiene el formato de un respaldo de QUQI_QA.' });
  const stat = await store.restoreDocs(cols, b.mode === 'replace' ? 'replace' : 'merge', req.user.name);
  broadcast({ op: 'resync' });
  res.json(stat);
}));

app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.use((req, res) => res.status(404).type('text').send('No encontrado'));

(async () => {
  await db.init();
  await auth.bootstrapAdmin();
  const port = process.env.PORT || 3000;
  app.listen(port, () => { azure.startScheduler(broadcast); console.log('QUQI_QA escuchando en el puerto ' + port + (ai.enabled() ? ' · IA: Gemini (' + ai.MODEL + ')' : ' · IA desactivada (falta GEMINI_API_KEY)') + (azure.enabled() ? ' · Azure DevOps: ' + azure.org() + ' (sync cada ' + azure.syncMinutes() + ' min)' : ' · Azure DevOps desactivado')); });
})().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
