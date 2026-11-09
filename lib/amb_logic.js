'use strict';
/* GENERADO desde amb_logic.js del tablero (build_web.py). No editar a mano. */
/*AMB_LOGIC_START*/
/* ================= Ambientes QA: lógica pura (réplica del Apps Script de Google Sheets) ================= */
const AMB_HOJAS = ['Servicios','Banca','Sitio Publico','App','Agil','Proveedores','Banca Empresas','Servidores'];
/* Columna (1 = A) de la que sale el "detalle" de cada hoja; en App depende de la fila */
const AMB_DET = { 'Servicios':4, 'Banca':2, 'Sitio Publico':2, 'Proveedores':2, 'Banca Empresas':1, 'Agil':1, 'Servidores':1 };
const AMB_VALIDOS = ['SI','NO','OCASIONALMENTE','MUY INTERMITENTE'];
const AMB_RESP_DEF = {
  'Servicios':{nombre:'Cristian Esteban Ochoa Rozo', correo:'cristian.ochoa@bancofinandina.com'},
  'Agil':{nombre:'Cristian Esteban Ochoa Rozo', correo:'cristian.ochoa@bancofinandina.com'},
  'Banca':{nombre:'Cristian De Jesus Sanjuan Ozuna', correo:'cristian.sanjuan@bancofinandina.com'},
  'Sitio Publico':{nombre:'Cristian De Jesus Sanjuan Ozuna', correo:'cristian.sanjuan@bancofinandina.com'},
  'App':{nombre:'Jorge Luis Madrid Plata', correo:'jorge.madridp@bancofinandina.com'},
  'Proveedores':{nombre:'Rodolfo Celis Campos', correo:'rodolfo.celis@bancofinandina.com'},
  'Banca Empresas':{nombre:'Erick Santiago Rodriguez Prieto', correo:'erick.rodriguezp@bancofinandina.com'},
  'Servidores':{nombre:'Wilmer Francisco Rodriguez Suarez', correo:'wilmer.rodriguezs@bancofinandina.com'}
};
const AMB_CORREOS_DEF = ['ana.cortes','oliverio.chacon','rodolfo.celis','jhon.salamancag','nancy.botero','sonia.canop','cristian.sanjuan','cristian.ochoa','jorge.madridp','jessica.daza','hector.arias','wilmer.rodriguezs','diana.leonr','diana.rodriguezr','paola.arevalo'].map(x => x + '@bancofinandina.com');
function ambDefaults(){
  return {
    correos: AMB_CORREOS_DEF.join(', '),
    evidenciaUrl: 'https://docs.google.com/spreadsheets/d/1qZUDKW2nHN11ArlwxA9LhLOx_271q5wCrmOjUMONeAU/edit?gid=1330488244#gid=1330488244',
    horasRecordatorio: 24,
    azure: { org:'BancoFinandina', proyecto:'Gestion Proyectos', area:'Gestion Proyectos\\QA', iteracion:'Gestion Proyectos\\Backlog', etiqueta:'Ambiente QA', flujo:'QA', estadoCierre:'Cerrado' },
    resp: JSON.parse(JSON.stringify(AMB_RESP_DEF))
  };
}
function mergeAmb(saved){
  const d = ambDefaults(); if(!saved) return d;
  if(typeof saved.correos==='string' && saved.correos.trim()) d.correos = saved.correos;
  if(typeof saved.evidenciaUrl==='string') d.evidenciaUrl = saved.evidenciaUrl;
  if(Number(saved.horasRecordatorio) > 0) d.horasRecordatorio = Number(saved.horasRecordatorio);
  if(saved.azure) Object.keys(d.azure).forEach(k => { if(typeof saved.azure[k]==='string') d.azure[k] = saved.azure[k]; });
  if(saved.resp) Object.keys(saved.resp).forEach(k => { const r = saved.resp[k] || {}; d.resp[k] = { nombre:String(r.nombre||''), correo:String(r.correo||'') }; });
  return d;
}
function ambSlug(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }
/* SI → 'SI'; NO, OCASIONALMENTE e INTERMITENTE → 'NO'; cualquier otro valor no dispara nada (igual que el script) */
function ambValorH(v){
  const u = String(v==null ? '' : v).trim().toUpperCase();
  if(u==='SI' || u==='SÍ') return 'SI';
  if(u==='NO') return 'NO';
  if(u.indexOf('OCASIONALMENTE')>=0 || u.indexOf('INTERMITENTE')>=0) return 'NO';
  return '';
}
function ambIsSI(v){ return ambValorH(v)==='SI'; }
/* n = número de fila en la hoja (1 = encabezado); cells = celdas A.. de esa fila (0-based) */
function ambDetalle(hoja, n, cells){
  let col = AMB_DET[hoja];
  if(hoja==='App') col = n <= 9 ? 2 : 1;
  if(!col) col = 1;
  return String(cells[col-1]==null ? '' : cells[col-1]).replace(/\s+/g,' ').trim();
}
function ambCell(v){
  if(v==null) return '';
  if(v instanceof Date) return isNaN(v) ? '' : v.toISOString();
  if(typeof v==='number') return Number.isInteger(v) ? String(v) : String(Math.round(v*1e6)/1e6);
  return String(v).replace(/\r/g,'').trim().slice(0, 600);
}
/* Serial de Excel o texto → ISO (la hora de pared se toma tal cual está en el archivo, en la zona del navegador) */
function ambToIso(v){
  if(v==null || v==='') return '';
  if(v instanceof Date) return isNaN(v) ? '' : v.toISOString();
  if(typeof v==='number' && v > 20000 && v < 80000){
    const ms = Math.round((v - 25569) * 86400000), d = new Date(ms);
    const w = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    return w.toISOString();
  }
  const s = String(v).trim(), m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(s);
  if(m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0).toISOString();
  const d = new Date(s); return isNaN(d) ? '' : d.toISOString();
}
function ambIssueStr(v){ const s = ambCell(v).replace(/^#/, ''); return /^\d+(\.0+)?$/.test(s) ? s.replace(/\.0+$/, '') : s; }
/* sheets: [{name, rows:[[...]]}] con celdas crudas (números, textos, fechas) */
function parseAmbSheets(sheets){
  const hojas = [], hist = []; let generales = null;
  const find = n => sheets.find(s => ambSlug(s.name)===ambSlug(n));
  AMB_HOJAS.forEach((nombre, orden) => {
    const s = find(nombre); if(!s) return;
    const head = (s.rows[0] || []).slice(0, 6).map(ambCell);
    while(head.length < 6) head.push('');
    const rows = {}; let count = 0;
    for(let i = 1; i < s.rows.length; i++){
      const r = s.rows[i] || [], n = i + 1;
      const c = []; for(let j = 0; j < 6; j++) c.push(ambCell(r[j]));
      const est = ambCell(r[2]);
      if(!c.some(x => x) && !est) continue;
      const det = ambDetalle(nombre, n, c);
      rows['r' + n] = { n, c, det, desc: c[3], est, hist: ambCell(r[7]).toUpperCase().slice(0,3)==='SI' ? 'SI' : (ambCell(r[7]) ? 'NO' : ''), ult: ambToIso(r[6]), aviso: '' };
      count++;
    }
    hojas.push({ id: ambSlug(nombre), name: nombre, orden, tipo:'hoja', headers: head, rows, total: count });
  });
  const h = find('Historico');
  if(h){
    for(let i = 1; i < h.rows.length; i++){
      const r = h.rows[i] || []; const hoja = ambCell(r[0]); if(!hoja) continue;
      hist.push({ hoja, hojaId: ambSlug(hoja), detalle: ambCell(r[1]), falla: ambCell(r[2]), fecha: ambToIso(r[3]), mensaje: ambCell(r[4]).slice(0, 2500), solventado: ambCell(r[5]), issue: ambIssueStr(r[6]), imp: true });
    }
  }
  const g = find('Generales');
  if(g){
    const rows = g.rows.map(r => (r||[]).slice(0,5).map(ambCell)).filter(r => r.some(x => x));
    if(rows.length) generales = { id:'generales', name:'Generales', tipo:'catalogo', orden: 99, headers: rows[0], filas: rows.slice(1) };
  }
  return { hojas, hist, generales };
}
/* Une los eventos del histórico: abierto / solucionado, con el tiempo que estuvo abierto */
function ambPair(records){
  const sorted = records.slice().sort((a,b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.id||'').localeCompare(String(b.id||'')));
  const open = {}, byId = {}, out = [];
  sorted.forEach(r => {
    const o = Object.assign({}, r); out.push(o); if(r.id) byId[r.id] = o;
    const key = r.hojaId + '|' + r.detalle;
    if(ambIsSI(r.falla)){ o.estado = 'Abierto'; open[key] = o; }
    else {
      o.estado = 'Cierre';
      const t = (r.abre && byId[r.abre]) || open[key];
      if(t && t.estado==='Abierto'){ t.estado = 'Solucionado'; t.cierre = r.fecha; t.horas = ambHorasDesde(t.fecha, r.fecha); if(!o.issue) o.issue = t.issue; }
      if(open[key] === t) delete open[key];
    }
  });
  out.forEach(o => { if(o.estado==='Abierto' && o.cierreEn){ o.estado = 'Solucionado'; o.cierre = o.cierreEn; o.horas = ambHorasDesde(o.fecha, o.cierreEn); } });
  return out;
}
function ambHorasDesde(iso, nowIso){ const a = Date.parse(iso), b = Date.parse(nowIso); return isNaN(a) || isNaN(b) ? 0 : Math.max(0, (b - a) / 3600000); }
/* Incidentes abiertos: filas cuyo estado actual es SI, con su registro de apertura (si existe) */
function ambOpenIncidents(hojas, records, nowIso, horasRec){
  const out = [];
  (hojas||[]).forEach(h => {
    Object.keys(h.rows||{}).forEach(rk => {
      const row = h.rows[rk]; if(!ambIsSI(row.est)) return;
      const cands = records.filter(r => ambIsSI(r.falla) && !r.cierreEn && r.hojaId===h.id && (r.rowKey ? r.rowKey===rk : r.detalle===row.det));
      cands.sort((a,b) => String(b.fecha).localeCompare(String(a.fecha)));
      const rec = cands[0] || null;
      const inicio = (rec && rec.fecha) || row.ult || '';
      const aviso = row.aviso || inicio;
      const horas = ambHorasDesde(inicio, nowIso), desdeAviso = ambHorasDesde(aviso, nowIso);
      out.push({ hojaId:h.id, hoja:h.name, rk, row, rec, detalle:row.det, desc:row.desc, inicio, aviso, horas, desdeAviso, vencido: desdeAviso >= (horasRec || 24) });
    });
  });
  return out.sort((a,b) => String(a.inicio).localeCompare(String(b.inicio)));
}
/* Transición de estado de una fila (lo que hace gestionarFallasQA al editar la columna C) */
function ambTransicion(old, nuevo){
  const vh = ambValorH(nuevo);
  return { valorH: vh, cambia: String(old||'') !== String(nuevo||''), abre: vh==='SI', cierra: vh==='NO' && ambIsSI(old), actualizaFecha: vh !== '' };
}
/* ---- mensajes (mismos textos del script) ---- */
function ambEsc(s){ return String(s==null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function ambAsignado(cfg, hoja){ const r = cfg.resp && cfg.resp[hoja]; return r ? r.nombre : ''; }
function ambAsunto(tipo, d){
  if(tipo==='inc') return '🚨 Incidente detectado en el servicio ' + d.hoja + ' - ' + d.detalle + (d.issue ? ' - Issue #' + d.issue : '');
  if(tipo==='cierre') return '✅ Servicio restablecido | Cierre de incidente ' + d.hoja + ' - ' + d.detalle;
  return '⏰ Recordatorio | Incidente pendiente - ' + d.hoja + ' - ' + d.detalle;
}
function ambMensaje(tipo, d, cfg){
  const url = cfg.evidenciaUrl || '', asg = d.asignado != null ? d.asignado : ambAsignado(cfg, d.hoja), I = d.issue ? String(d.issue) : '';
  const a = x => '<a href="' + ambEsc(x) + '">' + ambEsc(x) + '</a>';
  let text, html;
  if(tipo==='inc'){
    text = 'Hola, 👋\n\nSe informa que actualmente se presenta una afectación en \n' + d.hoja + '\n\n' +
      'Información del incidente\nAmbiente/Servicio: ' + d.hoja + '\nDetalle del error: ' + d.detalle + '\n' + (I ? 'Issue generado: ' + I + ' (Azure DevOps)\n' : '') + (asg ? 'Responsable asignado: ' + asg + '\n' : '') +
      '\nSolicitamos tu apoyo con la atención y gestión del incidente para\nrestablecer el servicio en el menor tiempo posible.\n\n' +
      'Puedes consultar toda la información del caso en los siguientes enlaces:\n' + (I ? 'Azure DevOps: ' + I + '\n' : '') + 'Evidencias y rutas del error:\n' + url + '\n\n' +
      'Agradecemos mantener actualizado el estado del Issue hasta el cierre\ndel incidente.\n\nCordialmente,\nEquipo de QA';
    html = 'Hola, 👋<br><br>Se informa que actualmente se presenta una afectación en <br><b>' + ambEsc(d.hoja) + '</b><br><br>' +
      '<b>Información del incidente</b><br><b>Ambiente/Servicio:</b> ' + ambEsc(d.hoja) + '<br><b>Detalle del error:</b> ' + ambEsc(d.detalle) + '<br>' +
      (I ? '<b>Issue generado:</b> ' + ambEsc(I) + ' (Azure DevOps)<br>' : '') + (asg ? '<b>Responsable asignado:</b> ' + ambEsc(asg) + '<br>' : '') +
      '<br>Solicitamos tu apoyo con la atención y gestión del incidente para<br>restablecer el servicio en el menor tiempo posible.<br><br>' +
      'Puedes consultar toda la información del caso en los siguientes enlaces:<br>' + (I ? '<b>Azure DevOps:</b> ' + ambEsc(I) + '<br>' : '') +
      '<b>Evidencias y rutas del error:</b><br>' + a(url) + '<br><br>Agradecemos mantener actualizado el estado del Issue hasta el cierre<br>del incidente.<br><br>Cordialmente,<br><b>Equipo de QA</b>';
  } else if(tipo==='cierre'){
    text = 'Hola, 👋\n\nNos complace informar que la afectación reportada en \n' + d.hoja + ' ha sido solucionada y actualmente el servicio opera con\nnormalidad.\n\n' +
      'Detalle del incidente\nServicio/Ambiente: ' + d.hoja + '\nIncidente reportado: ' + d.detalle + '\nEstado: ✅ Solucionado\n\n' +
      'Como parte del proceso de gestión del incidente, ' + (I ? 'el Issue ' + I + ' en Azure DevOps ha sido cerrado.\n\n' : 'el incidente ha sido cerrado.\n\n') +
      (asg ? 'Responsable de la atención: ' + asg + '\n\n' : '') +
      'Si deseas consultar el historial del incidente, las evidencias o la gestión\nrealizada, puedes acceder a:\n' + (I ? 'Issue en Azure DevOps: ' + I + '\n' : '') + 'Archivo histórico de incidentes:\n' + url + '\n\n' +
      'Agradecemos el apoyo y la gestión realizada para restablecer el servicio en el\nmenor tiempo posible.\n\nCordialmente,\nEquipo de QA';
    html = 'Hola, 👋<br><br>Nos complace informar que la afectación reportada en <br><b>' + ambEsc(d.hoja) + '</b> ha sido solucionada y actualmente el servicio opera con<br>normalidad.<br><br>' +
      '<b>Detalle del incidente</b><br><b>Servicio/Ambiente:</b> ' + ambEsc(d.hoja) + '<br><b>Incidente reportado:</b> ' + ambEsc(d.detalle) + '<br><b>Estado:</b> ✅ Solucionado<br><br>' +
      'Como parte del proceso de gestión del incidente, ' + (I ? 'el <b>Issue ' + ambEsc(I) + '</b> en Azure DevOps ha sido cerrado.<br><br>' : 'el incidente ha sido cerrado.<br><br>') +
      (asg ? '<b>Responsable de la atención:</b> ' + ambEsc(asg) + '<br><br>' : '') +
      'Si deseas consultar el historial del incidente, las evidencias o la gestión<br>realizada, puedes acceder a:<br>' + (I ? '<b>Issue en Azure DevOps:</b> ' + ambEsc(I) + '<br>' : '') +
      '<b>Archivo histórico de incidentes:</b><br>' + a(url) + '<br><br>Agradecemos el apoyo y la gestión realizada para restablecer el servicio en el<br>menor tiempo posible.<br><br>Cordialmente,<br><b>Equipo de QA</b>';
  } else {
    const hrs = Math.floor(d.horas || 0);
    text = 'Hola, 👋\n\nSe envía este recordatorio debido a que el incidente reportado continúa\nactivo y el servicio aún presenta afectaciones después de ' + hrs + ' horas\ndesde su detección.\n\n' +
      'Información del incidente\nServicio/Ambiente: ' + d.hoja + '\nDetalle del error: ' + d.detalle + '\n' + (I ? 'Azure DevOps: ' + I + '\n' : '') + (asg ? 'Responsable asignado: ' + asg + '\n' : '') +
      '\nAgradecemos priorizar la atención de este incidente y registrar las\nactualizaciones correspondientes en Azure DevOps, indicando el avance de\nla gestión o el tiempo estimado para la normalización del servicio.\n\n' +
      'Puedes consultar la información completa en:\n' + (I ? 'Issue en Azure DevOps: ' + I + '\n' : '') + 'Archivo de evidencias:\n' + url + '\n\n' +
      'Agradecemos tu pronta gestión para lograr el restablecimiento del servicio.\n\nCordialmente,\nEquipo de QA';
    html = 'Hola, 👋<br><br>Se envía este <b>recordatorio</b> debido a que el incidente reportado continúa<br>activo y el servicio aún presenta afectaciones después de ' + hrs + ' horas<br>desde su detección.<br><br>' +
      '<b>Información del incidente</b><br><b>Servicio/Ambiente:</b> ' + ambEsc(d.hoja) + '<br><b>Detalle del error:</b> ' + ambEsc(d.detalle) + '<br>' +
      (I ? '<b>Issue en Azure DevOps:</b> ' + ambEsc(I) + '<br>' : '') + (asg ? '<b>Responsable asignado:</b> ' + ambEsc(asg) + '<br>' : '') +
      '<br>Agradecemos priorizar la atención de este incidente y registrar las<br>actualizaciones correspondientes en Azure DevOps, indicando el avance de<br>la gestión o el tiempo estimado para la normalización del servicio.<br><br>' +
      'Puedes consultar la información completa en:<br>' + (I ? '<b>Issue en Azure DevOps:</b> ' + ambEsc(I) + '<br>' : '') + '<b>Archivo de evidencias:</b><br>' + a(url) + '<br><br>' +
      'Agradecemos tu pronta gestión para lograr el restablecimiento del servicio.<br><br>Cordialmente,<br><b>Equipo de QA</b>';
  }
  return { subject: ambAsunto(tipo, d), text, html, to: cfg.correos };
}
/* Datos para crear el Issue en Azure DevOps (lo que el script mandaba por API) */
function ambIssueDraft(d, cfg){
  const r = (cfg.resp && cfg.resp[d.hoja]) || {};
  return { titulo: d.hoja + ' - ' + d.detalle, descripcion: d.desc || '', area: cfg.azure.area, iteracion: cfg.azure.iteracion, etiquetas: cfg.azure.etiqueta, flujo: cfg.azure.flujo,
    asignado: r.correo || '', asignadoNombre: r.nombre || '', tipo: 'Issue', proyecto: cfg.azure.proyecto, org: cfg.azure.org };
}
function ambIssueText(x){
  return ['Tipo: ' + x.tipo, 'Título: ' + x.titulo, 'Descripción: ' + x.descripcion, 'Area Path: ' + x.area, 'Iteration Path: ' + x.iteracion, 'Tags: ' + x.etiquetas, 'Flujo funcional: ' + x.flujo, 'Asignado a: ' + (x.asignado || '—')].join('\n');
}
function ambStats(pairs, nowIso){
  const aperturas = pairs.filter(r => ambIsSI(r.falla));
  const sol = aperturas.filter(r => r.estado==='Solucionado'), ab = aperturas.filter(r => r.estado==='Abierto');
  const prom = sol.length ? sol.reduce((s,r) => s + (r.horas||0), 0) / sol.length : null;
  return { total: aperturas.length, solucionados: sol.length, abiertos: ab.length, promHoras: prom };
}

module.exports = { AMB_HOJAS, AMB_DET, AMB_VALIDOS, AMB_RESP_DEF, AMB_CORREOS_DEF, ambDefaults, mergeAmb, ambSlug, ambValorH, ambIsSI, ambDetalle, ambCell, ambToIso, ambIssueStr, parseAmbSheets, ambPair, ambHorasDesde, ambOpenIncidents, ambTransicion, ambEsc, ambAsignado, ambAsunto, ambMensaje, ambIssueDraft, ambIssueText, ambStats };
