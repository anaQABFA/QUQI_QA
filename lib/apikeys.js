'use strict';
/* Llaves de integración (solo lectura de porcentajes). Solo se guarda el hash SHA-256: la llave completa se muestra una única vez al crearla. */
const crypto = require('crypto');
const { q } = require('./db');

const MAX_ACTIVE = 10;
const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const COLS = 'id, name, prefix, created_at, created_by, last_used_at, uses, revoked_at';

async function list() { return (await q(`SELECT ${COLS} FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC`)).rows; }
async function create(name, by) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw { status: 400, msg: 'Ponle un nombre a la llave (por ejemplo, Fluxor).' };
  const n = (await q('SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL')).rows[0].n;
  if (n >= MAX_ACTIVE) throw { status: 400, msg: 'Ya hay ' + MAX_ACTIVE + ' llaves activas. Revoca alguna que no uses.' };
  const key = 'quqi_' + crypto.randomBytes(32).toString('base64url');
  const r = await q(`INSERT INTO api_keys (name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`, [name, key.slice(0, 9), hash(key), by || null]);
  return { key, info: r.rows[0] };
}
async function revoke(id) {
  const r = await q('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [id]);
  return !!r.rows[0];
}
/* Devuelve la llave si es válida y está activa (y registra el uso). */
async function verify(key) {
  key = String(key || '');
  if (!/^quqi_[A-Za-z0-9_-]{30,80}$/.test(key)) return null;
  const r = await q('UPDATE api_keys SET last_used_at=now(), uses=uses+1 WHERE key_hash=$1 AND revoked_at IS NULL RETURNING id, name', [hash(key)]);
  return r.rows[0] || null;
}
module.exports = { list, create, revoke, verify };
