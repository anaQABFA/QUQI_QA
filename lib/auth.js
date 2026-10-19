'use strict';
const crypto = require('crypto');
const { q } = require('./db');

const SECRET = process.env.SESSION_SECRET || '';
const COOKIE = 'qa_session';
const TTL_MS = 1000 * 60 * 60 * 12;      // la sesión dura 12 horas
const PROD = process.env.NODE_ENV === 'production';

/* ---------- contraseñas (scrypt, sin dependencias nativas) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [alg, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const exp = Buffer.from(h, 'hex');
    return calc.length === exp.length && crypto.timingSafeEqual(calc, exp);
  } catch (e) { return false; }
}
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'La contraseña debe tener al menos 10 caracteres.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Usa letras y al menos un número.';
  return null;
}

/* ---------- sesión: cookie firmada (HMAC) ---------- */
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function unsign(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, mac] = tok.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; }
  catch (e) { return null; }
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, user) {
  const tok = sign({ uid: user.id, pv: user.pv, exp: Date.now() + TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${PROD ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD ? '; Secure' : ''}`);
}

/* Carga el usuario de la sesión (o null). */
async function sessionUser(req) {
  const p = unsign(parseCookies(req)[COOKIE]);
  if (!p) return null;
  const r = await q('SELECT id, username, name, role, pv, must_change, active FROM users WHERE id=$1', [p.uid]);
  const u = r.rows[0];
  if (!u || !u.active || u.pv !== p.pv) return null;
  return u;
}

/* ---------- freno a intentos de acceso ---------- */
const fails = new Map();   // clave -> {n, until}
function lockedFor(key) {
  const f = fails.get(key);
  if (f && f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 60000);
  return 0;
}
/* limit: intentos fallidos antes del bloqueo. Por usuario son pocos (6); por IP son más (40), porque
   en una oficina todos salen por la misma IP y un solo descuido no debe bloquear a todo el equipo. */
function noteFail(key, limit) {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; }
  f.n++;
  if (f.n >= (limit || 6)) { f.until = Date.now() + 15 * 60000; f.n = 0; }
  fails.set(key, f);
}
function clearFails(key) { fails.delete(key); }
setInterval(() => { const t = Date.now(); fails.forEach((f, k) => { if (!f.until && f.n === 0) fails.delete(k); else if (f.until && f.until < t - 3600000) fails.delete(k); }); }, 600000).unref();

/* ---------- primer administrador ---------- */
async function bootstrapAdmin() {
  const n = (await q('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (n > 0) return;
  const username = String(process.env.ADMIN_USER || 'admin').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) { console.error('No hay usuarios y falta ADMIN_PASSWORD: define esa variable para crear el administrador inicial.'); process.exit(1); }
  const bad = passwordProblem(pw);
  if (bad) { console.error('ADMIN_PASSWORD no es válida: ' + bad); process.exit(1); }
  await q('INSERT INTO users(username,name,role,pass_hash,must_change) VALUES ($1,$2,$3,$4,false)',
    [username, process.env.ADMIN_NAME || 'Administrador', 'admin', hashPassword(pw)]);
  console.log('Administrador inicial creado: ' + username);
}

module.exports = { hashPassword, verifyPassword, passwordProblem, setSession, clearSession, sessionUser, lockedFor, noteFail, clearFails, bootstrapAdmin };
