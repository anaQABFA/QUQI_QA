'use strict';
const crypto = require('crypto');
const { pool, q } = require('./db');

const COLS = ['projects', 'analistas', 'bitacora', 'config', 'seguimiento', 'amb_hojas', 'amb_hist'];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 900 * 1024;

function newId() { const a = 'abcdefghijklmnopqrstuvwxyz0123456789'; const b = crypto.randomBytes(20); let s = ''; for (let i = 0; i < 20; i++) s += a[b[i] % 36]; return s; }
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Mezcla anidada (igual que el update de la base original); {__delete__:true} borra el campo. */
function deepMerge(base, patch) {
  const out = isObj(base) ? Object.assign({}, base) : {};
  Object.keys(patch).forEach(k => {
    const v = patch[k];
    if (isObj(v) && v.__delete__ === true) delete out[k];
    else if (isObj(v)) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  });
  return out;
}
function checkDoc(data) {
  if (!isObj(data)) throw { status: 400, msg: 'El documento debe ser un objeto.' };
  if (JSON.stringify(data).length > MAX_DOC) throw { status: 413, msg: 'Documento demasiado grande.' };
}

async function listDocs(col) {
  const r = await q('SELECT id, data, version FROM docs WHERE col=$1', [col]);
  return r.rows;
}
async function getDoc(col, id) {
  const r = await q('SELECT id, data, version FROM docs WHERE col=$1 AND id=$2', [col, id]);
  return r.rows[0] || null;
}
async function setDoc(col, id, data, who) {
  checkDoc(data);
  const r = await q(`INSERT INTO docs(col,id,data,version,updated_by) VALUES ($1,$2,$3,1,$4)
    ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by
    RETURNING version`, [col, id, data, who]);
  return { id, data, version: r.rows[0].version };
}
async function mergeDoc(col, id, patch, who) {
  if (!isObj(patch)) throw { status: 400, msg: 'Parche inválido.' };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cur = await c.query('SELECT data, version FROM docs WHERE col=$1 AND id=$2 FOR UPDATE', [col, id]);
    let data, version;
    if (cur.rows[0]) {
      data = deepMerge(cur.rows[0].data, patch); checkDoc(data);
      version = (await c.query('UPDATE docs SET data=$3, version=version+1, updated_at=now(), updated_by=$4 WHERE col=$1 AND id=$2 RETURNING version', [col, id, data, who])).rows[0].version;
    } else {
      data = deepMerge({}, patch); checkDoc(data);
      version = (await c.query('INSERT INTO docs(col,id,data,version,updated_by) VALUES ($1,$2,$3,1,$4) ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data RETURNING version', [col, id, data, who])).rows[0].version;
    }
    await c.query('COMMIT');
    return { id, data, version };
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { c.release(); }
}
async function delDoc(col, id) { await q('DELETE FROM docs WHERE col=$1 AND id=$2', [col, id]); }

async function exportAll() {
  /* azure_bugs es una copia calculada desde Azure DevOps: no va en el respaldo (se vuelve a generar). */
  const r = await q("SELECT col, id, data FROM docs WHERE col <> 'azure_bugs' ORDER BY col, id");
  const collections = {}; COLS.forEach(c => { collections[c] = {}; });
  r.rows.forEach(x => { (collections[x.col] = collections[x.col] || {})[x.id] = x.data; });
  return collections;
}
/* mode 'merge': inserta/actualiza lo que viene. mode 'replace': además borra lo que no viene (solo en colecciones incluidas). */
async function restoreDocs(collections, mode, who) {
  const c = await pool.connect(); const stat = { escritos: 0, borrados: 0, colecciones: {} };
  try {
    await c.query('BEGIN');
    for (const col of Object.keys(collections || {})) {
      if (!COLS.includes(col) || !isObj(collections[col])) continue;
      const ids = Object.keys(collections[col]).filter(i => ID_RE.test(i));
      for (const id of ids) {
        const data = collections[col][id]; checkDoc(data);
        await c.query(`INSERT INTO docs(col,id,data,version,updated_by) VALUES ($1,$2,$3,1,$4)
          ON CONFLICT (col,id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`, [col, id, data, who]);
        stat.escritos++;
      }
      stat.colecciones[col] = ids.length;
      if (mode === 'replace') {
        const d = await c.query('DELETE FROM docs WHERE col=$1 AND NOT (id = ANY($2::text[]))', [col, ids]);
        stat.borrados += d.rowCount;
      }
    }
    await c.query('COMMIT');
  } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { c.release(); }
  return stat;
}

module.exports = { COLS, ID_RE, newId, listDocs, getDoc, setDoc, mergeDoc, delDoc, exportAll, restoreDocs, deepMerge };
