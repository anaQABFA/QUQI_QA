'use strict';
/* Seguimiento (novedades) y tiempo de pruebas en el servidor, para la integración de solo lectura (Fluxor).
   Es el mismo cálculo que hace la pantalla (testClock, freezeInfo, novedadRow en public/app.html):
   los días congelados por la prioridad de otro proyecto NO cuentan como tiempo de QA. */
const { dayCO } = require('./azure');

const pad2 = n => String(n).padStart(2, '0');
const parseYmd = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(); };
const ymd = d => d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const diffDays = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const toYmd = v => { const s = String(v || ''); if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; return dayCO(s) || ''; };

/* ---- festivos de Colombia y días hábiles ---- */
function easterUTC(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, mo - 1, da);
}
const holCache = {};
function festivosCO(y) {
  if (holCache[y]) return holCache[y];
  const set = {}, DAY = 86400000, U = (m, d) => Date.UTC(y, m - 1, d);
  const nextMon = ms => { const w = new Date(ms).getUTCDay(); return ms + (w === 1 ? 0 : (8 - w) % 7) * DAY; };
  const put = ms => { const d = new Date(ms); set[d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())] = true; };
  [[1, 1], [5, 1], [7, 20], [8, 7], [12, 8], [12, 25]].forEach(x => put(U(x[0], x[1])));
  [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]].forEach(x => put(nextMon(U(x[0], x[1]))));
  const E = easterUTC(y);
  put(E - 3 * DAY); put(E - 2 * DAY); put(nextMon(E + 39 * DAY)); put(nextMon(E + 60 * DAY)); put(nextMon(E + 68 * DAY));
  return (holCache[y] = set);
}
function isBizDay(s) { const d = parseYmd(s), w = d.getUTCDay(); return w !== 0 && w !== 6 && !festivosCO(d.getUTCFullYear())[ymd(d)]; }
/* Días hábiles en [a, b) o en [a, b] si inclusive. */
function bizDaysBetween(a, b, inclusive) {
  let n = 0, d = parseYmd(a), guard = 0; const end = parseYmd(b);
  while ((inclusive ? d <= end : d < end) && guard++ < 4000) { if (isBizDay(ymd(d))) n++; d = addDays(d, 1); }
  return n;
}

/* ---- congelamientos (congelado → reanudado) ---- */
function freezeInfo(entries, todayStr) {
  const ev = entries.filter(e => e.tipo === 'congelado' || e.tipo === 'reanudado')
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.ts).localeCompare(String(b.ts)));
  let open = null; const intervals = [];
  ev.forEach(e => {
    if (e.tipo === 'congelado') { if (!open) open = { desde: e.fecha, prio: e.prioProyecto || '' }; }
    else if (open) { intervals.push(Object.assign({}, open, { hasta: e.fecha })); open = null; }
  });
  intervals.forEach(i => { i.dias = bizDaysBetween(i.desde, i.hasta, false); });
  let days = intervals.reduce((s, i) => s + i.dias, 0);
  if (open) { open.dias = bizDaysBetween(open.desde, todayStr, true); days += open.dias; }
  return { frozen: !!open, current: open, intervals, days, periods: intervals.length + (open ? 1 : 0) };
}

/* ---- tiempo de pruebas (mismo cálculo que testClock de la pantalla) ---- */
const isClosed = p => !!p && (p.status === 'certificado' || !!p.cerradoEn);
const isReceived = p => !!p && (p.recepcion === 'recibido' || !!p.recibidoEn || p.recepcion === undefined);
const closedAt = p => (p && (p.cerradoEn || p.certifiedAt)) || '';
function tiempoPruebas(p, entries, todayStr) {
  const plan = Number(p.diasPlan) > 0 ? Number(p.diasPlan) : null;
  const received = isReceived(p), closed = isClosed(p);
  const startRaw = toYmd(p.testStart) || (received ? toYmd(p.createdAt) : '');
  const start = startRaw || todayStr;
  const notStarted = !closed && (!received || !startRaw || todayStr < startRaw);
  let end = closed ? (toYmd(closedAt(p)) || todayStr) : todayStr;
  if (end < start) end = start;
  const elapsed = notStarted ? 0 : bizDaysBetween(start, end, true);
  const fz = notStarted ? { days: 0, frozen: false, periods: 0 } : freezeInfo(entries || [], end);
  const congelados = Math.min(elapsed, fz.days);
  const usados = Math.max(0, elapsed - congelados);
  return {
    iniciado: !notStarted,
    diasPlan: plan,
    diasUsados: usados,
    diasCongelados: congelados,
    congeladoAhora: !!fz.frozen,
    periodosCongelado: fz.periods || 0,
    diasSobrePlan: plan != null && usados > plan ? usados - plan : 0,
    diasRestantes: plan != null && !closed ? Math.max(0, plan - usados) : null,
  };
}

/* ---- novedades del seguimiento, ya redactadas ---- */
const TIPOS = {
  stopper: 'Bug stopper / bloqueante', hu_nueva: 'Alcance: HU nueva', criterio_nuevo: 'Alcance: criterio nuevo',
  criterio_actualizado: 'Alcance: criterio actualizado', desistido: 'Desistido', no_aplica: 'Criterio / HU no aplicable',
  congelado: 'Congelado por prioridad de otro proyecto', certificado_qa: 'Certificado QA', amb_bloqueado: 'Bloqueado por ambiente',
  comentario: 'Comentario', nota: 'Nota del día', reanudado: 'Reanudado', reactivado: 'Reactivado',
};
/* Cambios de alcance: lo que cambia qué se prueba. */
const ALCANCE = new Set(['hu_nueva', 'criterio_nuevo', 'criterio_actualizado', 'desistido', 'no_aplica', 'reactivado']);
const num = v => { const n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; };
const join = (...xs) => xs.filter(Boolean).join(' — ');

function novedad(e, fz) {
  const tipo = TIPOS[e.tipo] ? e.tipo : 'nota';
  let detalle = TIPOS[tipo], texto = e.texto || '', estado = '';
  switch (tipo) {
    case 'stopper': detalle = 'Bug stopper' + (e.bugId ? ' #' + e.bugId : ''); estado = e.estado === 'resuelto' ? 'Resuelto' + (e.resueltoEn ? ' el ' + String(e.resueltoEn).slice(0, 10) : '') : 'Abierto'; break;
    case 'hu_nueva': detalle = 'Se agregó la HU ' + (e.hu || '') + ' (peso ' + (e.peso != null ? e.peso + '%' : '—') + (e.nCriterios ? ', ' + e.nCriterios + ' criterios' : '') + ')'; texto = join(e.desc, e.texto); break;
    case 'criterio_nuevo': detalle = 'Criterio nuevo'; texto = join(e.despues, e.texto ? 'Motivo: ' + e.texto : ''); break;
    case 'criterio_actualizado': detalle = 'Criterio actualizado'; texto = 'Antes: ' + (e.antes || '') + ' | Ahora: ' + (e.despues || '') + (e.texto ? ' | Motivo: ' + e.texto : ''); break;
    case 'desistido': detalle = 'Se desistió ' + (e.crit != null ? 'un criterio' : 'la HU'); texto = join(e.critTexto, e.texto ? 'Motivo: ' + e.texto : ''); break;
    case 'no_aplica': detalle = (e.crit != null ? 'Criterio' : 'HU') + ' no aplicable'; texto = join(e.critTexto, e.texto ? 'Motivo: ' + e.texto : ''); break;
    case 'reactivado': detalle = 'Reactivado'; texto = e.critTexto || ''; break;
    case 'comentario': detalle = 'Comentario'; estado = e.estadoCrit ? (e.crit != null ? 'Criterio ' : 'HU ') + e.estadoCrit : ''; break;
    case 'congelado': {
      detalle = 'Congelado por prioridad de ' + (e.prioProyecto || 'otro proyecto');
      const iv = fz && fz.intervals.find(i => i.desde === e.fecha);
      estado = iv ? 'Reanudado el ' + iv.hasta + ' (' + iv.dias + ' día' + (iv.dias === 1 ? '' : 's') + ' hábil' + (iv.dias === 1 ? '' : 'es') + ' sin contar)' : (fz && fz.current && fz.current.desde === e.fecha ? 'Sigue congelado' : '');
      break;
    }
    case 'reanudado': detalle = 'Proyecto reanudado'; break;
    case 'amb_bloqueado': detalle = 'Bloqueado por ambiente' + (e.ambiente ? ' ' + e.ambiente : '') + (e.horaIni ? ' · ' + e.horaIni + (e.horaFin ? ' – ' + e.horaFin : '') : ''); estado = e.horaFin ? 'Cerrado' : 'Abierto'; break;
    case 'certificado_qa': { const cq = e.cq || {}; detalle = 'Certificado QA'; texto = join(num(cq.casosOk) + ' de ' + num(cq.casosDis) + ' casos exitosos', e.texto); break; }
    default: detalle = 'Nota del día';
  }
  return {
    id: e.id, tipo, tipoEtiqueta: TIPOS[tipo], fecha: e.fecha || null,
    hu: e.hu ? String(e.hu) + (e.crit != null ? ' · criterio ' + (Number(e.crit) + 1) : '') : null,
    detalle, texto: texto || null, estado: estado || null, autor: e.autor || null,
    registradoEn: e.ts || null, despuesDeCertificar: !!e.postCert,
  };
}
const ordenar = list => list.slice().sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(b.ts).localeCompare(String(a.ts)));

/* Seguimiento (todo menos alcance) y cambios de alcance, más recientes primero. */
function seguimientoDe(entries, todayStr) {
  const fz = freezeInfo(entries, todayStr);
  const out = { seguimiento: [], alcance: [] };
  ordenar(entries).forEach(e => (ALCANCE.has(e.tipo) ? out.alcance : out.seguimiento).push(novedad(e, fz)));
  return out;
}

/* Bugs de Azure vinculados al proyecto (si los hay). */
const ABIERTO = s => !/^(closed|cerrado|done|resolved|resuelto|removed)$/i.test(String(s || ''));
function bugsDe(p, az) {
  const vinculado = !!(p && p.azureCfg);
  const lista = vinculado && az && Array.isArray(az.bugs) ? az.bugs : [];
  const base = az && az.webBase ? String(az.webBase) : '';
  return {
    vinculado,
    total: lista.length,
    abiertos: lista.filter(b => ABIERTO(b.e)).length,
    sincronizadoEn: (az && az.syncedAt) || null,
    error: (vinculado && az && az.error) || null,
    lista: lista.map(b => ({
      id: b.id, titulo: b.t, severidad: b.s || null, prioridad: b.pr || null, estado: b.e || null,
      creado: b.c || null, resuelto: b.r || null, cerrado: b.k || null, abierto: ABIERTO(b.e),
      url: (() => { const bb = (b.pj && az && az.webBases && az.webBases[b.pj]) || base; return bb && /^https?:\/\//i.test(bb) ? bb + encodeURIComponent(b.id) : null; })(),
      proyectoAzure: b.pj || null,
    })),
  };
}

/* Dónde están los casos de prueba en Azure (el plan vinculado). */
function planPruebasUrl(p, az) {
  if (!p || !p.azureTest) return null;
  const t = az && az.tests;
  if (t && t.webUrl && t.plan && t.plan.id) {
    const u = String(t.webUrl).replace(/\/_testManagement\/analytics\/progressreport.*$/i, '/_testPlans/define?planId=' + encodeURIComponent(t.plan.id));
    if (/^https?:\/\//i.test(u)) return u;
  }
  const cfg = p.azureTest, raw = typeof cfg === 'string' ? cfg : (cfg.plan || cfg.url || '');
  return /^https?:\/\//i.test(String(raw)) ? String(raw) : null;
}

module.exports = { tiempoPruebas, seguimientoDe, bugsDe, planPruebasUrl, freezeInfo, bizDaysBetween, isBizDay, ALCANCE };
