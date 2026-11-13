'use strict';
/* Estadísticas de Ambientes (QA y DEV) para la integración de solo lectura con Fluxor.
   Lee el histórico (amb_hist) y el estado actual de las hojas (amb_hojas); no escribe nada.
   Reutiliza el emparejamiento apertura→cierre de amb_logic (ambPair), el mismo del tablero de QUQI. */
const db = require('./db');
const L = require('./amb_logic');
const { dayCO } = require('./azure');

const round1 = n => Math.round((Number(n) || 0) * 10) / 10;
const DAY = 86400000;
const ymdAdd = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
/* Semana ISO (lunes a domingo) de una fecha AAAA-MM-DD → { key: '2026-W46', desde: lunes } */
function semanaDe(ymd) {
  const d = new Date(ymd + 'T12:00:00Z'), dow = (d.getUTCDay() + 6) % 7;     // 0 = lunes
  const lunes = new Date(d.getTime() - dow * DAY), jueves = new Date(lunes.getTime() + 3 * DAY);
  const y = jueves.getUTCFullYear(), ene4 = new Date(Date.UTC(y, 0, 4, 12)), lunesSem1 = new Date(ene4.getTime() - ((ene4.getUTCDay() + 6) % 7) * DAY);
  const n = Math.round((lunes - lunesSem1) / (7 * DAY)) + 1;
  return { key: y + '-W' + String(n).padStart(2, '0'), desde: lunes.toISOString().slice(0, 10) };
}
const grupoDe = r => String(r.hoja || '').replace(/\s+DEV$/i, '') || '—';

async function cargar() {
  const hist = (await db.q("SELECT id, data FROM docs WHERE col='amb_hist'")).rows.map(x => Object.assign({}, x.data, { id: x.id }));
  const hojas = (await db.q("SELECT id, data FROM docs WHERE col='amb_hojas'")).rows
    .map(x => Object.assign({}, x.data, { id: x.id })).filter(h => h.tipo !== 'catalogo');
  return { hist, hojas };
}

/* amb: 'qa' | 'dev' | 'todos'; meses: ventana del histórico y del detalle (1 a 24). */
async function estadisticas(opts) {
  const amb = ['qa', 'dev'].includes(opts && opts.amb) ? opts.amb : 'todos';
  const meses = Math.min(24, Math.max(1, parseInt(opts && opts.meses, 10) || 6));
  const nowIso = new Date().toISOString(), hoy = dayCO(nowIso);
  const { hist, hojas } = await cargar();
  const delAmb = x => amb === 'todos' || L.ambEnvOf(x) === amb;

  /* Emparejar por ambiente (cada ambiente tiene sus hojas). */
  const pares = L.ambPair(hist.filter(delAmb));
  const aperturas = pares.filter(r => L.ambIsSI(r.falla)).map(r => {
    const env = L.ambEnvOf(r), abierta = r.estado === 'Abierto';
    const horas = abierta ? L.ambHorasDesde(r.fecha, nowIso) : (r.horas || 0);
    const dia = dayCO(r.fecha) || '';
    return {
      id: r.id, amb: env, ambEtiqueta: L.AMB_ENV_LABEL[env], grupo: grupoDe(r), hoja: r.hoja || '', servicio: r.detalle || '',
      descripcion: r.desc || '', error: r.descError || '', inicio: r.fecha || null, fin: abierta ? null : (r.cierre || r.cierreEn || null),
      horas: round1(horas), diasBloqueo: round1(horas / 24), estado: abierta ? 'Abierta' : 'Solucionada',
      dia, semana: dia ? semanaDe(dia).key : '', mes: dia.slice(0, 7),
      issue: r.issue || '', issueUrl: r.issueUrl || L.ambIssueUrl(L.ambDefaults(env), r.issue) || '',
      reportadoPor: r.autor || '', cerradoPor: r.cerradoPor || '',
    };
  }).filter(a => a.dia);

  /* Ventana: desde el primer día del mes (meses-1) atrás. */
  const desde = (() => { const [y, m] = hoy.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 - (meses - 1), 1)); return d.toISOString().slice(0, 10); })();
  const enVentana = aperturas.filter(a => a.dia >= desde);
  const sol = enVentana.filter(a => a.estado === 'Solucionada');
  const sumaH = list => round1(list.reduce((s, a) => s + a.horas, 0));
  const mttr = list => { const s = list.filter(a => a.estado === 'Solucionada'); return s.length ? round1(s.reduce((t, a) => t + a.horas, 0) / s.length) : null; };

  /* Fallas abiertas AHORA según el estado de las hojas (lo que ve el tablero de QUQI). */
  const abiertasAhora = L.ambOpenIncidents(hojas.filter(delAmb), hist.filter(delAmb), nowIso, 24).map(i => {
    const env = L.ambEnvOf(hojas.find(h => h.id === i.hojaId) || {}), rec = i.rec || {};
    return {
      amb: env, ambEtiqueta: L.AMB_ENV_LABEL[env], grupo: String(i.hoja || '').replace(/\s+DEV$/i, ''), servicio: i.detalle || '',
      descripcion: i.desc || '', error: rec.descError || '', inicio: i.inicio || null, horas: round1(i.horas), diasBloqueo: round1(i.horas / 24),
      issue: rec.issue || '', issueUrl: rec.issueUrl || L.ambIssueUrl(L.ambDefaults(env), rec.issue) || '', vencido: !!i.vencido,
    };
  });

  /* Series: últimos 30 días, 12 semanas y la ventana de meses. */
  const porDia = []; for (let k = 29; k >= 0; k--) { const d = ymdAdd(hoy, -k); const l = aperturas.filter(a => a.dia === d); porDia.push({ fecha: d, fallas: l.length, solucionadas: l.filter(a => a.estado === 'Solucionada').length }); }
  const porSemana = []; for (let k = 11; k >= 0; k--) {
    const s = semanaDe(ymdAdd(hoy, -7 * k)), l = aperturas.filter(a => a.semana === s.key);
    porSemana.push({ semana: s.key, desde: s.desde, fallas: l.length, solucionadas: l.filter(a => a.estado === 'Solucionada').length, horasBloqueo: sumaH(l), mttrHoras: mttr(l) });
  }
  const porMes = []; for (let k = meses - 1; k >= 0; k--) {
    const [y, m] = hoy.split('-').map(Number), key = new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 7), l = aperturas.filter(a => a.mes === key);
    porMes.push({ mes: key, fallas: l.length, solucionadas: l.filter(a => a.estado === 'Solucionada').length, horasBloqueo: sumaH(l), diasBloqueo: round1(sumaH(l) / 24), mttrHoras: mttr(l) });
  }

  /* Por grupo (hoja: Servicios, Banca, App…) y ambiente. */
  const gmap = new Map();
  enVentana.forEach(a => { const k = a.amb + '|' + a.grupo; if (!gmap.has(k)) gmap.set(k, []); gmap.get(k).push(a); });
  const porGrupo = [...gmap].map(([k, l]) => ({
    amb: l[0].amb, ambEtiqueta: l[0].ambEtiqueta, grupo: l[0].grupo, fallas: l.length,
    abiertas: l.filter(a => a.estado === 'Abierta').length, solucionadas: l.filter(a => a.estado === 'Solucionada').length,
    horasTotal: sumaH(l), diasBloqueo: round1(sumaH(l) / 24), mttrHoras: mttr(l),
  })).sort((a, b) => b.fallas - a.fallas || a.grupo.localeCompare(b.grupo, 'es'));

  /* Por servicio (detalle de la fila): tiempos de atención (MTTR) y recurrencia. */
  const smap = new Map();
  enVentana.forEach(a => { const k = a.amb + '|' + a.grupo + '|' + a.servicio; if (!smap.has(k)) smap.set(k, []); smap.get(k).push(a); });
  const porServicio = [...smap].map(([k, l]) => ({
    amb: l[0].amb, ambEtiqueta: l[0].ambEtiqueta, grupo: l[0].grupo, servicio: l[0].servicio, ocurrencias: l.length,
    abiertas: l.filter(a => a.estado === 'Abierta').length, solucionadas: l.filter(a => a.estado === 'Solucionada').length,
    horasTotal: sumaH(l), diasBloqueo: round1(sumaH(l) / 24), mttrHoras: mttr(l),
    ultima: l.map(a => a.inicio).sort().pop() || null,
  })).sort((a, b) => b.ocurrencias - a.ocurrencias || b.horasTotal - a.horasTotal);
  const recurrentes = porServicio.filter(s => s.ocurrencias >= 2).slice(0, 20);

  const resumen = {
    fallas: enVentana.length, abiertasAhora: abiertasAhora.length, solucionadas: sol.length,
    mttrHoras: mttr(enVentana), horasBloqueo: sumaH(enVentana), diasBloqueo: round1(sumaH(enVentana) / 24),
    hoy: aperturas.filter(a => a.dia === hoy).length,
    semana: aperturas.filter(a => a.semana === semanaDe(hoy).key).length,
    mes: aperturas.filter(a => a.mes === hoy.slice(0, 7)).length,
    recurrentes: recurrentes.length,
  };

  const incidentes = enVentana.slice().sort((a, b) => String(b.inicio).localeCompare(String(a.inicio))).slice(0, 3000);
  return { generadoEn: nowIso, amb, meses, desde, hoy, resumen, abiertasAhora, porDia, porSemana, porMes, porGrupo, porServicio, recurrentes, incidentes };
}

module.exports = { estadisticas, semanaDe };
