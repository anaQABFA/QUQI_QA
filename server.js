'use strict';
const path = require('path');
const express = require('express');
const compression = require('compression');
const db = require('./lib/db');
const auth = require('./lib/auth');
const store = require('./lib/store');
const ai = require('./lib/ai');
const azure = require('./lib/azure');
const ambientes = require('./lib/ambientes');
const cargue = require('./lib/cargue');
const perm = require('./lib/perm');
const apikeys = require('./lib/apikeys');
const metrics = require('./lib/metrics');

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
app.use((req, res, next) => (req.path === '/api/ai' || req.path === '/api/admin/restore' || req.path === '/api/cargue/analizar') ? bigJson(req, res, next) : smallJson(req, res, next));

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

/* ---------- integración (Fluxor u otros): solo lectura de porcentajes, con llave ---------- */
const keyHits = new Map();   // id de llave → { n, t } (límite de 120 consultas por minuto)
const normQ = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
app.use('/api/integracion', wrap(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).set('Allow', 'GET, HEAD').json({ error: 'Solo lectura: usa GET.' });
  const lock = auth.lockedFor('k:' + req.ip);
  if (lock) return res.status(429).json({ error: 'Demasiados intentos con una llave inválida. Espera ' + lock + ' min.' });
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const key = m ? m[1] : String(req.headers['x-api-key'] || '').trim();
  const k = key ? await apikeys.verify(key) : null;
  if (!k) { auth.noteFail('k:' + req.ip, 20); return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Llave inválida o revocada. Envíala en la cabecera Authorization: Bearer <llave>.' }); }
  const now = Date.now(), h = keyHits.get(k.id) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  if (++h.n > 120) { keyHits.set(k.id, h); return res.status(429).set('Retry-After', '60').json({ error: 'Límite de 120 consultas por minuto.' }); }
  keyHits.set(k.id, h);
  req.apiKey = k; next();
}));
/* ⚠ NO BORRAR esta línea: integración con Fluxor (tiempo de pruebas, bugs, plan de pruebas y /detalle). Todo el código está en lib/integracion.js. */
require('./lib/integracion')(app, wrap);
async function integracionRows() {
  const pr = (await db.q("SELECT id, data, updated_at FROM docs WHERE col='projects'")).rows;
  const az = new Map((await db.q("SELECT id, data FROM docs WHERE col='azure_bugs'")).rows.map(r => [r.id, r.data]));
  return pr.map(r => metrics.summarize(r, az.get(r.id), new Date())).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
app.get('/api/integracion/proyectos', wrap(async (req, res) => {
  let list = await integracionRows();
  const est = normQ(req.query.estado);
  if (est === 'abiertos') list = list.filter(p => !p.cerrado);
  else if (est === 'cerrados') list = list.filter(p => p.cerrado);
  else if (est && est !== 'todos') list = list.filter(p => p.estado === est);
  const nom = normQ(req.query.nombre);
  if (nom) list = list.filter(p => normQ(p.nombre).includes(nom));
  res.json({ generadoEn: new Date().toISOString(), total: list.length, proyectos: list });
}));
app.get('/api/integracion/proyectos/:id', wrap(async (req, res) => {
  const p = (await integracionRows()).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No existe un proyecto con ese id.' });
  res.json(Object.assign({ generadoEn: new Date().toISOString() }, p));
}));

/* ---------- cola de correo de Ambientes: la recoge el Apps Script de la cuenta de Google (clave AMB_MAIL_SECRET, sin sesión) ---------- */
app.use('/api/ambientes-cola', wrap(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const lock = auth.lockedFor('q:' + req.ip);
  if (lock) return res.status(429).json({ error: 'Demasiados intentos con una clave inválida. Espera ' + lock + ' min.' });
  const secret = String(process.env.AMB_MAIL_SECRET || ''), m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const a = Buffer.from(m ? m[1] : ''), b = Buffer.from(secret);
  if (!secret || !m || a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) { auth.noteFail('q:' + req.ip, 20); return res.status(401).json({ error: 'Clave inválida.' }); }
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ error: 'Usa POST.' });
  next();
}));
app.post('/api/ambientes-cola/pendientes', wrap(async (req, res) => res.json({ mensajes: await ambientes.colaPendientes() })));
app.post('/api/ambientes-cola/confirmar', wrap(async (req, res) => res.json(await ambientes.colaConfirmar(req.body && req.body.ids))));

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
const staffOnly = (req, res, next) => (req.user.role === 'admin' || req.user.role === 'analista') ? next() : res.status(403).json({ error: 'Tu perfil es de solo lectura.' });

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
  const mctx = u.must_change ? null : await ctxOf(req).catch(() => null);
  res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role, roleLabel: perm.ROLE_LABEL[u.role] || u.role, mustChange: u.must_change, analystDocId: mctx ? mctx.analystDocId : null }, ai: { enabled: ai.enabled(), model: ai.enabled() ? ai.MODEL : null },
    ambientes: ambientes.status(),
    azure: { enabled: azure.enabled(), org: azure.enabled() ? azure.org() : null, project: azure.defaultProject() || null, testProject: azure.testProject() || null, syncMinutes: azure.syncMinutes() },
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
const clients = new Map();   // respuesta SSE -> contexto del usuario (cada quien recibe solo lo que puede ver)
function broadcast(ev) {
  if (ev.col === 'archivos_data') return;   /* el contenido de los archivos no se difunde: se pide al descargar */
  let reassigned = false;
  if (ev.op === 'set' && ev.col === 'projects') {
    const before = JSON.stringify(perm.PA.get(ev.id) || null); perm.setPA(ev.id, ev.data);
    reassigned = before !== JSON.stringify(perm.PA.get(ev.id) || null);
  } else if (ev.op === 'del' && ev.col === 'projects') perm.PA.delete(ev.id);
  clients.forEach((ctx, c) => {
    let out = ev;
    if (ev.op === 'set') {
      const d = perm.readDoc(ctx, ev.col, ev.id, ev.data);
      if (d == null) { if (ev.col === 'projects') out = { op: 'del', col: 'projects', id: ev.id }; else return; }
      else if (d !== ev.data) out = Object.assign({}, ev, { data: d });
    }
    try { c.write('data: ' + JSON.stringify(out) + '\n\n'); } catch (e) {}
  });
  if (reassigned) clients.forEach((ctx, c) => { try { c.write('data: {"op":"resync"}\n\n'); } catch (e) {} });
}

/* Contexto del usuario: rol y, si es analista QA, su ficha de la bitácora (se crea o se enlaza por nombre la primera vez). */
const analystJobs = new Map(), analystCache = new Map();
const normN = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function analystDocFor(u) {
  if (u.role !== 'analista') return null;
  const cached = analystCache.get(u.id);
  if (cached) { const d = await store.getDoc('analistas', cached); if (d && Number(d.data.userId) === u.id) return cached; analystCache.delete(u.id); }
  if (analystJobs.has(u.id)) return analystJobs.get(u.id);
  const job = (async () => {
    const rows = await store.listDocs('analistas');
    let hit = rows.find(r => r.data && Number(r.data.userId) === u.id);
    if (!hit) {
      const nn = normN(u.name); hit = rows.find(r => r.data && !r.data.userId && normN(r.data.name) === nn);
      if (hit) { const d = await store.mergeDoc('analistas', hit.id, { userId: u.id }, 'sistema'); broadcast({ op: 'set', col: 'analistas', id: hit.id, data: d.data, version: d.version }); }
    }
    if (hit) return hit.id;
    const nid = store.newId(), d = await store.setDoc('analistas', nid, { name: u.name, userId: u.id, createdAt: new Date().toISOString(), createdBy: 'sistema' }, 'sistema');
    broadcast({ op: 'set', col: 'analistas', id: nid, data: d.data, version: d.version });
    return nid;
  })();
  analystJobs.set(u.id, job);
  try { const id = await job; analystCache.set(u.id, id); return id; } finally { analystJobs.delete(u.id); }
}
/* Analistas QA activos: sirven para atribuir los casos ejecutados en Azure al analista correcto. */
const analystsList = async () => (await db.q("SELECT id, name, username FROM users WHERE role='analista' AND active")).rows;
/* Cada usuario analista tiene su ficha en la bitácora desde que se crea (no al primer ingreso). Si el administrador eligió una ficha existente sin usuario, se vincula. */
async function ensureAnalyst(u, linkId) {
  if (!u || u.role !== 'analista') return null;
  if (linkId && store.ID_RE.test(String(linkId))) {
    const d = await store.getDoc('analistas', String(linkId));
    if (d && !d.data.userId) { const m = await store.mergeDoc('analistas', d.id, { userId: u.id }, 'sistema'); broadcast({ op: 'set', col: 'analistas', id: d.id, data: m.data, version: m.version }); analystCache.set(u.id, d.id); return d.id; }
  }
  return analystDocFor(u);
}
/* Si cambia el nombre de un usuario, se actualiza en su ficha de la bitácora y en las asignaciones de los proyectos. */
async function syncUserName(uid, name) {
  const fi = (await store.listDocs('analistas')).find(r => r.data && Number(r.data.userId) === uid);
  if (fi && fi.data.name !== name) { const m = await store.mergeDoc('analistas', fi.id, { name }, 'sistema'); broadcast({ op: 'set', col: 'analistas', id: fi.id, data: m.data, version: m.version }); }
  for (const r of await store.listDocs('projects')) {
    const a = r.data && r.data.asignacion; if (!a) continue;
    const ks = Object.keys(perm.ASSIGN_KEYS).filter(k => a[k] && Number(a[k].id) === uid && a[k].name !== name); if (!ks.length) continue;
    const patch = { asignacion: {} }; ks.forEach(k => { patch.asignacion[k] = { id: uid, name }; });
    const m = await store.mergeDoc('projects', r.id, patch, 'sistema'); broadcast({ op: 'set', col: 'projects', id: r.id, data: m.data, version: m.version });
  }
}
async function ctxOf(req) {
  if (!req.ctx) req.ctx = { uid: req.user.id, role: req.user.role, name: req.user.name, analystDocId: await analystDocFor(req.user) };
  return req.ctx;
}
app.get('/api/stream', wrap(async (req, res) => {
  const ctx = await ctxOf(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.set(res, ctx);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
}));
/* azure_bugs solo se lee desde el navegador; únicamente el servidor lo escribe (al sincronizar con Azure DevOps). */
const colOk = (req, res, next) => {
  const readOnly = req.params.col === 'azure_bugs' && req.method === 'GET';
  const ok = (store.COLS.includes(req.params.col) || readOnly) && (!req.params.id || store.ID_RE.test(req.params.id));
  return ok ? next() : res.status(400).json({ error: 'Colección o id inválido.' });
};

/* Asignaciones del proyecto: PMO líder, analista QA y PO (usuarios activos con ese rol). */
async function normAsig(a) {
  if (!perm.isObj(a)) throw { status: 400, msg: 'Indica el PMO líder, el analista QA y el PO del proyecto.' };
  const out = {};
  for (const k of Object.keys(perm.ASSIGN_KEYS)) {
    const id = parseInt(a[k] && (a[k].id != null ? a[k].id : a[k]), 10);
    const u = Number.isInteger(id) ? (await db.q('SELECT id, name, role, active FROM users WHERE id=$1', [id])).rows[0] : null;
    if (!u || !u.active || u.role !== perm.ASSIGN_KEYS[k]) throw { status: 400, msg: 'Elige un usuario activo con el perfil «' + perm.ROLE_LABEL[perm.ASSIGN_KEYS[k]] + '» para ' + (k === 'pmoLider' ? 'PMO líder' : k === 'analista' ? 'analista QA' : 'PO') + '.' };
    out[k] = { id: u.id, name: u.name };
  }
  return out;
}
const fail = (res, e) => res.status((e && e.status) || 500).json({ error: (e && (e.msg || e.error)) || 'Error.' });
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
/* Datos que fija el servidor (no se confía en lo que mande el navegador). */
function stampComment(ctx, op, cur, body) {
  const texto = String((body && body.texto) || '').trim().slice(0, 2000);
  if (!texto) throw { status: 400, msg: 'Escribe el comentario.' };
  if (op === 'create') return { projectId: String((body && body.projectId) || ''), texto, autorId: ctx.uid, autor: ctx.name, rol: perm.ROLE_LABEL[ctx.role], ts: new Date().toISOString() };
  return Object.assign({}, cur, { texto, editedAt: new Date().toISOString() });
}

/* Lista mínima (id y nombre) de proyectos abiertos para registrar apoyo en un proyecto que no se tiene asignado. */
app.get('/api/proyectos-apoyo', staffOnly, wrap(async (req, res) => {
  const rows = await store.listDocs('projects');
  res.json(rows.filter(r => r.data && !metrics.isClosed(r.data)).map(r => ({ id: r.id, name: String(r.data.name || '') })).sort((a, b) => a.name.localeCompare(b.name, 'es')));
}));
/* Lectura de un solo documento (se usa para bajar el contenido de un archivo subido). */
app.get('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  const ctx = await ctxOf(req), col = req.params.col, r = await store.getDoc(col, req.params.id);
  const d = r ? perm.readDoc(ctx, col, r.id, r.data) : null;
  if (d == null) return res.status(404).json({ error: 'No existe o no tienes acceso.' });
  res.json({ id: r.id, data: d, version: r.version });
}));
app.get('/api/docs/:col', colOk, wrap(async (req, res) => {
  const ctx = await ctxOf(req), col = req.params.col;
  if (col === 'archivos_data') return res.status(400).json({ error: 'El contenido de los archivos se pide de uno en uno.' });
  const rows = await store.listDocs(col), out = [];
  rows.forEach(r => { const d = perm.readDoc(ctx, col, r.id, r.data); if (d != null) out.push({ id: r.id, data: d, version: r.version }); });
  res.json(out);
}));
/* Un analista QA puede probar como máximo 2 proyectos a la vez (abiertos = recibidos en QA y sin cerrar). Se valida cuando un proyecto pasa a contar para él:
   al asignarlo, al recibirlo en QA o al reabrirlo. Lo ya asignado antes no se toca. */
const MAX_PROJ_ANALISTA = 2;
const countsFor = p => !!p && !metrics.isClosed(p) && metrics.isReceived(p);
async function checkProjectLimit(id, cur, nxt) {
  const a = nxt && nxt.asignacion && nxt.asignacion.analista; if (!a || a.id == null || !countsFor(nxt)) return;
  const wasHis = cur && countsFor(cur) && cur.asignacion && cur.asignacion.analista && Number(cur.asignacion.analista.id) === Number(a.id);
  if (wasHis) return;
  const others = (await store.listDocs('projects')).filter(r => r.id !== id && r.data && r.data.asignacion && r.data.asignacion.analista && Number(r.data.asignacion.analista.id) === Number(a.id) && countsFor(r.data));
  if (others.length >= MAX_PROJ_ANALISTA) throw { status: 400, msg: (a.name || 'El analista') + ' ya tiene ' + others.length + ' proyectos abiertos (' + others.slice(0, 3).map(r => r.data.name || r.id).join(' y ') + '). Un analista puede probar máximo ' + MAX_PROJ_ANALISTA + ' a la vez: cierra uno o asigna este proyecto a otro analista.' };
}
async function syncPname(id, name) {
  const r = await store.getDoc('azure_bugs', id);
  if (r && r.data && r.data.pname !== name) { const m = await store.mergeDoc('azure_bugs', id, { pname: name }, 'sistema'); broadcast({ op: 'set', col: 'azure_bugs', id, data: m.data, version: m.version }); }
}
/* Archivos subidos: registro ('archivos') y contenido por trozos ('archivos_data'). Tope de 8 MB por archivo. */
const MAX_FILE = 8 * 1024 * 1024, MAX_CHUNK = 700000;
function checkFileDoc(col, b) {
  if (!perm.isObj(b) || typeof b.projectId !== 'string' || !b.projectId) throw { status: 400, msg: 'Falta el proyecto del archivo.' };
  if (col === 'archivos') {
    if (!['figma', 'req'].includes(b.kind)) throw { status: 400, msg: 'Tipo de archivo inválido.' };
    if (!(Number(b.size) >= 0) || Number(b.size) > MAX_FILE) throw { status: 413, msg: 'El archivo supera el máximo de 8 MB.' };
    return { projectId: b.projectId, kind: b.kind, name: String(b.name || 'archivo').slice(0, 200), mime: String(b.mime || '').slice(0, 120), size: Number(b.size) || 0, chunks: Math.max(0, Math.min(40, parseInt(b.chunks, 10) || 0)), by: String(b.by || '').slice(0, 120), at: String(b.at || new Date().toISOString()).slice(0, 40) };
  }
  if (typeof b.chunk !== 'string' || b.chunk.length > MAX_CHUNK || !/^[A-Za-z0-9+/=]*$/.test(b.chunk)) throw { status: 413, msg: 'Trozo de archivo inválido.' };
  return { projectId: b.projectId, fid: String(b.fid || '').slice(0, 60), i: parseInt(b.i, 10) || 0, chunk: b.chunk };
}
/* Valida y prepara una escritura. Devuelve { data } con el documento a guardar (o { patch } en PATCH). */
async function prepWrite(req, op, id) {
  const ctx = await ctxOf(req), col = req.params.col, curRow = id ? await store.getDoc(col, id) : null, cur = curRow ? curRow.data : null;
  let body = req.body, kind = !cur ? 'create' : (op === 'delete' ? 'delete' : 'update');
  if (op === 'delete') {
    if (!cur && ctx.role !== 'admin') throw { status: 404, msg: 'No existe.' };
    const pr = perm.writeProblem(ctx, col, id, 'delete', cur, null); if (pr) throw { status: 403, msg: pr };
    return { ctx, cur };
  }
  if (col === 'archivos' || col === 'archivos_data') { body = checkFileDoc(col, body); if (col === 'archivos') body.by = ctx.name; }
  if (col === 'comentarios') body = stampComment(ctx, kind, cur, body);
  let nxt = op === 'patch' ? store.deepMerge(cur || {}, body) : body;
  if (col === 'projects') {
    if (ctx.role === 'analista') {   /* el analista no cambia quién está asignado */
      if (op === 'patch') { body = Object.assign({}, body); delete body.asignacion; nxt = store.deepMerge(cur || {}, body); }
      else { nxt = Object.assign({}, body); if (cur && cur.asignacion) nxt.asignacion = cur.asignacion; else delete nxt.asignacion; }
    } else if (ctx.role === 'admin' && (kind === 'create' || (nxt && !same(nxt.asignacion, cur && cur.asignacion)))) {
      if (kind === 'create' || nxt.asignacion) { nxt = Object.assign({}, nxt); nxt.asignacion = await normAsig(nxt.asignacion); if (op === 'patch') body = Object.assign({}, body, { asignacion: nxt.asignacion }); }
    }
  }
  if (col === 'projects' && nxt && kind !== 'delete') await checkProjectLimit(id, cur, nxt);
  if (col === 'bitacora' && ctx.role === 'analista') { nxt = Object.assign({}, nxt, { analystId: ctx.analystDocId }); if (op === 'patch') body = Object.assign({}, body, { analystId: ctx.analystDocId }); }
  const pr = perm.writeProblem(ctx, col, id, kind, cur, nxt); if (pr) throw { status: 403, msg: pr };
  return { ctx, cur, data: op === 'patch' ? undefined : nxt, patch: op === 'patch' ? body : undefined };
}
app.post('/api/docs/:col', colOk, wrap(async (req, res) => {
  try {
    const id = store.newId(), w = await prepWrite(req, 'post', null), d = await store.setDoc(req.params.col, id, w.data, req.user.name);
    broadcast({ op: 'set', col: req.params.col, id, data: d.data, version: d.version }); res.json({ id, version: d.version });
  } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.put('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  try {
    const w = await prepWrite(req, 'put', req.params.id), d = await store.setDoc(req.params.col, req.params.id, w.data, req.user.name);
    broadcast({ op: 'set', col: req.params.col, id: d.id, data: d.data, version: d.version }); res.json({ id: d.id, version: d.version });
    if (req.params.col === 'projects') syncPname(d.id, d.data.name).catch(() => {});
  } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.patch('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  try {
    const w = await prepWrite(req, 'patch', req.params.id), d = await store.mergeDoc(req.params.col, req.params.id, w.patch, req.user.name);
    broadcast({ op: 'set', col: req.params.col, id: d.id, data: d.data, version: d.version }); res.json({ id: d.id, version: d.version, data: perm.readDoc(w.ctx, req.params.col, d.id, d.data) });
    if (req.params.col === 'projects') syncPname(d.id, d.data.name).catch(() => {});
  } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.delete('/api/docs/:col/:id', colOk, wrap(async (req, res) => {
  try { await prepWrite(req, 'delete', req.params.id); } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
  if (req.params.col === 'analistas') {
    const ficha = await store.getDoc('analistas', req.params.id);
    if (ficha && ficha.data && ficha.data.userId) return res.status(400).json({ error: 'Esta ficha pertenece a un usuario activo: elimina primero el usuario en Administración.' });
  }
  await store.delDoc(req.params.col, req.params.id);
  broadcast({ op: 'del', col: req.params.col, id: req.params.id });
  if (req.params.col === 'analistas') {
    const bd = await db.q("DELETE FROM docs WHERE col='bitacora' AND left(id, length($1) + 1) = $1 || '_' RETURNING id", [req.params.id]);
    bd.rows.forEach(r => broadcast({ op: 'del', col: 'bitacora', id: r.id }));
  }
  if (req.params.col === 'projects') {
    await store.delDoc('azure_bugs', req.params.id); broadcast({ op: 'del', col: 'azure_bugs', id: req.params.id });
    const cm = await db.q("DELETE FROM docs WHERE col='comentarios' AND data->>'projectId'=$1 RETURNING id", [req.params.id]);
    cm.rows.forEach(r => broadcast({ op: 'del', col: 'comentarios', id: r.id }));
    const ar = await db.q("DELETE FROM docs WHERE col IN ('archivos','archivos_data') AND data->>'projectId'=$1 RETURNING id, col", [req.params.id]);
    ar.rows.forEach(r => broadcast({ op: 'del', col: r.col, id: r.id }));
  }
  res.json({ ok: true });
}));

/* ---------- Azure DevOps (solo lectura) ---------- */
const azErr = (res, e) => res.status((e && e.status) || 502).json({ error: (e && e.msg) || 'No se pudo consultar Azure DevOps.', code: (e && e.code) || 'azure' });
app.post('/api/azure/test', staffOnly, wrap(async (req, res) => {
  if (!azure.enabled()) return res.status(503).json({ error: 'La conexión con Azure DevOps no está configurada en el servidor.', code: 'azure_disabled' });
  if (!azure.rateOk(req.user.id)) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espera unos minutos.', code: 'rate_limited' });
  try { res.json(await azure.preview(req.body)); } catch (e) { azErr(res, e); }
}));
app.post('/api/azure/test-plan', staffOnly, wrap(async (req, res) => {
  if (!azure.enabled()) return res.status(503).json({ error: 'La conexión con Azure DevOps no está configurada en el servidor.', code: 'azure_disabled' });
  if (!azure.rateOk(req.user.id)) return res.status(429).json({ error: 'Demasiadas consultas seguidas. Espera unos minutos.', code: 'rate_limited' });
  try { res.json(await azure.previewTests(req.body)); } catch (e) { azErr(res, e); }
}));
app.post('/api/azure/sync/:id', staffOnly, wrap(async (req, res) => {
  if (!store.ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (req.user.role === 'analista' && !perm.projAssigned('analista', req.user.id, req.params.id)) return res.status(403).json({ error: 'Ese proyecto no está asignado a ti.' });
  if (!azure.enabled()) return res.status(503).json({ error: 'La conexión con Azure DevOps no está configurada en el servidor.', code: 'azure_disabled' });
  const force = !!(req.body && req.body.force);
  if (force && !azure.rateOk(req.user.id)) return res.status(429).json({ error: 'Demasiadas sincronizaciones seguidas. Espera unos minutos.', code: 'rate_limited' });
  try { res.json(await azure.syncProject(req.params.id, req.user.name, { force, broadcast, analysts: analystsList })); } catch (e) { azErr(res, e); }
}));

/* ---------- IA (Gemini) ---------- */
app.post('/api/ai', staffOnly, wrap(async (req, res) => {
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
  const role = perm.ROLES.includes(b.role) ? b.role : 'analista';
  let nu;
  try { nu = (await db.q('INSERT INTO users(username,name,role,pass_hash,must_change) VALUES ($1,$2,$3,$4,true) RETURNING id', [username, name, role, auth.hashPassword(b.password)])).rows[0]; }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Ese usuario ya existe.' }); throw e; }
  if (role === 'analista') await ensureAnalyst({ id: nu.id, name, role }, b.analistaId);
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
  if (perm.ROLES.includes(b.role)) { add('role', b.role); sets.push('pv=pv+1'); }
  if (typeof b.active === 'boolean') { add('active', b.active); sets.push('pv=pv+1'); }
  if (b.password) {
    const bad = auth.passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
    add('pass_hash', auth.hashPassword(b.password)); add('must_change', true); sets.push('pv=pv+1');
  }
  if (sets.length) await db.q('UPDATE users SET ' + sets.join(', ') + ' WHERE id=$1', vals);
  const nm = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : cur.name;
  if (nm !== cur.name) await syncUserName(id, nm);
  if (perm.ROLES.includes(b.role) && b.role === 'analista' && cur.role !== 'analista') await ensureAnalyst({ id, name: nm, role: 'analista' }, b.analistaId);
  res.json({ ok: true });
}));
/* Llaves de integración: se crean y revocan aquí; la llave completa solo se muestra al crearla. */
app.get('/api/admin/apikeys', adminOnly, wrap(async (req, res) => res.json(await apikeys.list())));
app.post('/api/admin/apikeys', adminOnly, wrap(async (req, res) => { const r = await apikeys.create(req.body && req.body.name, req.user.username); res.json({ key: r.key, info: r.info }); }));
app.delete('/api/admin/apikeys/:id', adminOnly, wrap(async (req, res) => { const ok = await apikeys.revoke(parseInt(req.params.id, 10)); if (!ok) return res.status(404).json({ error: 'No existe o ya estaba revocada.' }); res.json({ ok: true }); }));
/* Fichas de la bitácora que aún no tienen usuario (para vincularlas al crear un analista). */
app.get('/api/admin/analistas-libres', adminOnly, wrap(async (req, res) => res.json((await store.listDocs('analistas')).filter(r => r.data && !r.data.userId).map(r => ({ id: r.id, name: r.data.name })))));
/* Eliminar un usuario: no se permite si tiene proyectos asignados (se desactiva en su lugar); su bitácora se conserva. */
app.delete('/api/admin/users/:id', adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = (await db.q('SELECT * FROM users WHERE id=$1', [id])).rows[0]; if (!cur) return res.status(404).json({ error: 'No existe.' });
  if (id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario.' });
  if (cur.role === 'admin' && cur.active) {
    const n = (await db.q("SELECT count(*)::int AS n FROM users WHERE role='admin' AND active AND id<>$1", [id])).rows[0].n;
    if (!n) return res.status(400).json({ error: 'Debe quedar al menos un administrador activo.' });
  }
  const mine = [];
  for (const r of await store.listDocs('projects')) { const a = r.data && r.data.asignacion; if (a && Object.keys(perm.ASSIGN_KEYS).some(k => a[k] && Number(a[k].id) === id)) mine.push(r.data.name || r.id); }
  if (mine.length) return res.status(409).json({ error: 'No se puede eliminar: está asignado a ' + mine.length + ' proyecto' + (mine.length === 1 ? '' : 's') + ' (' + mine.slice(0, 5).join(', ') + (mine.length > 5 ? '…' : '') + '). Reasígnalos primero, o desactiva el usuario.' });
  await db.q('DELETE FROM users WHERE id=$1', [id]);
  const fi = (await store.listDocs('analistas')).find(r => r.data && Number(r.data.userId) === id);
  if (fi) { const m = await store.setDoc('analistas', fi.id, Object.assign({}, fi.data, { userId: null, sinUsuario: true }), 'sistema'); broadcast({ op: 'set', col: 'analistas', id: fi.id, data: m.data, version: m.version }); }
  analystCache.delete(id);
  res.json({ ok: true, bitacoraConservada: !!fi });
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
  perm.loadPA(await store.listDocs('projects'));
  broadcast({ op: 'resync' });
  res.json(stat);
}));

/* ---------- Ambientes QA: estado de una fila → histórico + Issue en Azure + correo ---------- */
const ambOk = (req, res, next) => ['admin', 'analista', 'po', 'ambientes'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Tu perfil no gestiona los ambientes.' });
const ambHits = new Map();
function ambRate(uid) {
  const now = Date.now(), arr = (ambHits.get(uid) || []).filter(t => now - t < 300000);
  if (arr.length >= 40) { ambHits.set(uid, arr); return false; }
  arr.push(now); ambHits.set(uid, arr); return true;
}
app.get('/api/ambientes/estado', ambOk, wrap(async (req, res) => res.json(Object.assign({}, ambientes.status(), ambientes.status().modoCorreo === 'cola' && req.user.role === 'admin' ? { cola: await ambientes.colaInfo() } : {}))));
app.post('/api/ambientes/marcar', ambOk, wrap(async (req, res) => {
  if (!ambRate(req.user.id)) return res.status(429).json({ error: 'Demasiados cambios seguidos; espera unos minutos.' });
  try { res.json(await ambientes.setEstado(req.user, req.body, broadcast)); } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.post('/api/ambientes/reintentar', ambOk, wrap(async (req, res) => {
  if (!ambRate(req.user.id)) return res.status(429).json({ error: 'Demasiados intentos seguidos; espera unos minutos.' });
  try { res.json(await ambientes.reintentar(req.user, req.body && req.body.id, broadcast)); } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.post('/api/ambientes/probar-correo', adminOnly, wrap(async (req, res) => {
  if (!ambRate(req.user.id)) return res.status(429).json({ error: 'Demasiados intentos seguidos; espera unos minutos.' });
  try { res.json(await ambientes.probarCorreo(req.body && req.body.to)); } catch (e) { if (e && e.status && e.msg) return fail(res, e); throw e; }
}));
app.post('/api/ambientes/recordatorios', adminOnly, wrap(async (req, res) => res.json(await ambientes.runReminders(broadcast))));

/* ---------- Cargue de proyectos en QA (solo administrador): Drive/archivo → HU → IA → Azure DevOps ---------- */
const cargueHits = new Map();
function cargueRate(uid) {
  const now = Date.now(), arr = (cargueHits.get(uid) || []).filter(t => now - t < 300000);
  if (arr.length >= (+process.env.CARGUE_MAX_5MIN || 30)) { cargueHits.set(uid, arr); return false; }
  arr.push(now); cargueHits.set(uid, arr); return true;
}
app.get('/api/cargue/estado', adminOnly, wrap(async (req, res) => res.json(cargue.status())));
app.post('/api/cargue/carpetas', adminOnly, wrap(async (req, res) => {
  if (!cargueRate(req.user.id)) return res.status(429).json({ error: 'Demasiadas consultas seguidas; espera unos minutos.' });
  res.json(await cargue.carpetas(req.body && req.body.raiz));
}));
app.post('/api/cargue/analizar', adminOnly, wrap(async (req, res) => {
  if (!cargueRate(req.user.id)) return res.status(429).json({ error: 'Demasiadas consultas seguidas; espera unos minutos.' });
  res.json({ id: cargue.analizar(req.user, req.body || {}) });
}));
app.post('/api/cargue/generar', adminOnly, wrap(async (req, res) => {
  if (!cargueRate(req.user.id)) return res.status(429).json({ error: 'Demasiados cargues seguidos; espera unos minutos.' });
  res.json({ id: cargue.generar(req.user, req.body || {}) });
}));
app.get('/api/cargue/trabajos/:id', adminOnly, wrap(async (req, res) => { const j = cargue.getJob(req.params.id, req.query.desde); j ? res.json(j) : res.status(404).json({ error: 'Ese proceso ya no está en memoria (el servidor se reinició o pasaron más de 3 horas). Revisa el historial.' }); }));
app.get('/api/cargue/historial', adminOnly, wrap(async (req, res) => res.json(await cargue.historial())));
app.get('/api/cargue/historial/:id', adminOnly, wrap(async (req, res) => { const d = await cargue.historialDetalle(req.params.id); d ? res.json(d) : res.status(404).json({ error: 'No existe ese registro.' }); }));

app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h', setHeaders: (res, f) => { if (/\.(html|js)$/.test(f) && !/vendor/.test(f)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use((req, res) => res.status(404).type('text').send('No encontrado'));

(async () => {
  await db.init();
  await auth.bootstrapAdmin();
  perm.loadPA(await store.listDocs('projects'));
  for (const u of (await db.q("SELECT id, name, role FROM users WHERE role='analista' AND active")).rows) { try { await ensureAnalyst(u); } catch (e) { console.error('Ficha de bitácora de ' + u.name + ': ' + e.message); } }
  const port = process.env.PORT || 3000;
  await cargue.init();
  app.listen(port, () => { azure.startScheduler(broadcast, analystsList); ambientes.startScheduler(broadcast); console.log('QUQI_QA escuchando en el puerto ' + port + (ai.enabled() ? ' · IA: Gemini (' + ai.MODEL + ')' : ' · IA desactivada (falta GEMINI_API_KEY)') + (azure.enabled() ? ' · Azure DevOps: ' + azure.org() + ' (sync cada ' + azure.syncMinutes() + ' min)' : ' · Azure DevOps desactivado')); });
})().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
