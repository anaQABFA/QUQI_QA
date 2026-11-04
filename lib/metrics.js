'use strict';
/* Cálculo de porcentajes de un proyecto en el servidor. Es el mismo cálculo que hace la pantalla
   (entrega = projectProgress, QA certificado = pruCalc); hay una prueba que compara ambos. */
const { dayCO } = require('./azure');

const round1 = n => Math.round(n * 10) / 10;

/* ---- pesos: HU y criterios ---- */
function equalShares(n) {
  if (n <= 0) return [];
  const base = Math.floor(1000 / n);
  const a = new Array(n).fill(base / 10);
  a[n - 1] = (1000 - base * (n - 1)) / 10;
  return a;
}
const toNumOrNull = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const isHUExcluded = h => { if (h.excluido) return true; const cr = h.criterios || []; return cr.length > 0 && cr.every(c => c.excluido); };
const activeCrit = h => (h.criterios || []).filter(c => !c.excluido);
const critTotalActive = h => activeCrit(h).reduce((s, c) => s + (Number(c.pesoPct) || 0), 0);
const projScale = hs => { const t = (hs || []).filter(h => !isHUExcluded(h)).reduce((s, h) => s + (Number(h.pesoPct) || 0), 0); return t > 0 ? 100 / t : 1; };
function syncHUStatus(h) {
  const all = h.criterios || [];
  if (h.excluido || (all.length && all.every(c => c.excluido))) { h.estado = 'excluida'; h.recibidaEn = null; return h; }
  const cr = all.filter(c => !c.excluido);
  if (cr.length) {
    const n = cr.filter(c => c.recibido).length;
    h.estado = n === 0 ? 'pendiente' : (n === cr.length ? 'recibida' : 'parcial');
    if (n === cr.length) {
      const dates = cr.map(c => c.recibidoEn).filter(Boolean).sort();
      h.recibidaEn = dates.length ? dates[dates.length - 1] : (h.recibidaEn || null);
    } else h.recibidaEn = null;
  } else {
    if (h.estado !== 'recibida') h.estado = 'pendiente';
    if (h.estado === 'pendiente') h.recibidaEn = null;
  }
  return h;
}
function normalizeHU(h0) {
  const h = Object.assign({}, h0);
  const legacyReceived = h.estado === 'recibida';
  let cr = Array.isArray(h.criterios) ? h.criterios : [];
  cr = cr.map(c => (typeof c === 'string')
    ? { texto: c, pesoPct: null, recibido: legacyReceived, recibidoEn: legacyReceived ? (h.recibidaEn || null) : null }
    : { texto: String(c.texto || ''), pesoPct: toNumOrNull(c.pesoPct), recibido: !!c.recibido, recibidoEn: c.recibidoEn || null, excluido: c.excluido || null });
  if (cr.length && cr.some(c => c.pesoPct == null)) { const sh = equalShares(cr.length); cr.forEach((c, i) => { c.pesoPct = sh[i]; }); }
  h.criterios = cr;
  h.excluido = h.excluido || null;
  h.pesoPct = Number(h.pesoPct) || 0;
  return syncHUStatus(h);
}
function huFraction(h) {
  if (isHUExcluded(h)) return 0;
  const all = h.criterios || [];
  if (!all.length) return h.estado === 'recibida' ? 1 : 0;
  const cr = activeCrit(h), tot = critTotalActive(h);
  if (tot <= 0) return cr.filter(c => c.recibido).length / cr.length;
  return cr.reduce((s, c) => s + (c.recibido ? (Number(c.pesoPct) || 0) : 0), 0) / tot;
}
function projectProgress(p) {
  const hs = (p.historias || []).map(normalizeHU), sc = projScale(hs);
  return hs.reduce((s, h) => s + (isHUExcluded(h) ? 0 : (Number(h.pesoPct) || 0) * huFraction(h) * sc), 0);
}

/* ---- avance de pruebas (QA certificado) ---- */
function pruInt(v) { if (v === '' || v == null) return null; const n = Number(String(v).trim()); return Number.isInteger(n) && n >= 0 ? n : null; }
function pruCalc(v) {
  v = v || {};
  const g = k => pruInt(v[k]) || 0;
  const total = g('total'), na = g('na'), ok = g('ok'), fail = g('fail'), block = g('block'), pause = g('pause');
  const base = total - na, used = ok + fail + block + pause, pend = base - used, errors = [];
  ['total', 'na', 'ok', 'fail', 'block', 'pause'].forEach(k => { if (v[k] !== '' && v[k] != null && pruInt(v[k]) == null) errors.push('num'); });
  if (total <= 0) errors.push('total');
  else if (na > total) errors.push('na>total');
  else if (base <= 0) errors.push('base');
  if (base > 0 && used > base) errors.push('used>base');
  const valid = !errors.length, pc = n => valid ? n / base * 100 : null;
  return { total, na, base, ok, fail, block, pause, pend, used, valid,
    cert: pc(ok), probado: pc(ok + fail), exito: valid && ok + fail > 0 ? ok / (ok + fail) * 100 : null };
}
/* Mismo origen que ve la pantalla: con plan de Azure vinculado, el último conteo sincronizado; si no, lo registrado a mano. */
function qaInfo(p, az) {
  if (p.azureTest && az && az.tests && az.tests.counts) {
    const t = az.tests;
    return { src: 'azure', at: t.syncedAt || az.syncedAt || null, c: pruCalc({ total: t.total, na: t.counts.na, ok: t.counts.ok, fail: t.counts.fail, block: t.counts.block, pause: t.counts.pause }) };
  }
  if (p.pruebas) return { src: 'manual', at: p.pruebas.at || null, c: pruCalc(p.pruebas) };
  return null;
}

/* ---- estado ---- */
const isClosed = p => !!p && (p.status === 'certificado' || !!p.cerradoEn);
const isReceived = p => !!p && (p.recepcion === 'recibido' || !!p.recibidoEn || p.recepcion === undefined);   // sin campo = proyecto anterior a la recepción: ya recibido
const toYmd = v => { const s = String(v || ''); if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; return dayCO(s) || ''; };
function estadoOf(p, today) {
  if (isClosed(p)) return { codigo: 'cerrado', etiqueta: 'Cerrado · Certificado QA' };
  if (!isReceived(p)) return { codigo: 'backlog', etiqueta: 'En backlog QA' };
  const sd = toYmd(p.testStart);
  if (sd && sd > today) return { codigo: 'proximo', etiqueta: 'Recibido · próximo a probar' };
  return { codigo: 'en_pruebas', etiqueta: 'En seguimiento' };
}
const pct = n => n == null ? null : round1(n);

/* Lo que se entrega a una integración: solo porcentajes y datos básicos del proyecto. */
function summarize(row, az, now) {
  const p = row.data || {}, today = dayCO((now || new Date()).toISOString());
  const qi = qaInfo(p, az), c = qi && qi.c.valid ? qi.c : null, e = estadoOf(p, today);
  return {
    id: row.id,
    nombre: p.name || '',
    estado: e.codigo,
    estadoEtiqueta: e.etiqueta,
    cerrado: e.codigo === 'cerrado',
    recibidoEn: toYmd(p.recibidoEn) || null,
    inicioPruebas: toYmd(p.testStart) || null,
    pctEntrega: round1(projectProgress(p)),
    pctQaCertificado: c ? pct(c.cert) : null,
    pctProbado: c ? pct(c.probado) : null,
    pctExito: c ? pct(c.exito) : null,
    casos: c ? { total: c.total, noAplicables: c.na, aplicables: c.base, exitosos: c.ok, fallidos: c.fail, bloqueados: c.block, pausados: c.pause, pendientes: c.pend } : null,
    fuentePruebas: c ? qi.src : null,
    pruebasActualizadoEn: c ? qi.at : null,
    actualizadoEn: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

module.exports = { summarize, projectProgress, pruCalc, qaInfo, estadoOf, normalizeHU, round1 };
