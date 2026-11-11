'use strict';
/* Ambientes QA en el servidor: cambia el estado de una fila (SI / NO / OCASIONALMENTE / MUY INTERMITENTE), registra el histórico,
   crea o cierra el Issue en Azure DevOps y envía el correo, igual que hacía el Apps Script de Google Sheets.
   También envía solos los recordatorios de los incidentes que siguen abiertos.

   Variables de entorno (todas secretas; nunca van en el código):
     AMB_MAIL_URL, AMB_MAIL_SECRET   → servicio web de Apps Script que envía el correo (ver apps_script_correo.gs)
     AZURE_DEVOPS_PAT_WRITE          → llave de Azure con Work Items → Read & Write (si falta, se usa AZURE_DEVOPS_PAT)
     AZURE_DEVOPS_ORG                → organización (si falta, la de la configuración de Ambientes)
     AMB_REMINDERS=off               → apaga los recordatorios automáticos;  AMB_REMINDER_MINUTES (10 por defecto) → cada cuánto se revisan */
const store = require('./store');
const db = require('./db');
const L = require('./amb_logic');

/* Acepta la URL /exec completa o, por comodidad, solo el «ID de implementación» (AKfycb…) que muestra Apps Script. */
function normMailUrl(v) {
  const u = String(v || '').trim().replace(/^["']|["']$/g, '');
  if (/^AKfy[A-Za-z0-9_-]{20,}$/.test(u)) return 'https://script.google.com/macros/s/' + u + '/exec';
  return u;
}
const mailUrl = () => normMailUrl(process.env.AMB_MAIL_URL);
const mailSecret = () => String(process.env.AMB_MAIL_SECRET || '').trim();
const azPat = () => String(process.env.AZURE_DEVOPS_PAT_WRITE || process.env.AZURE_DEVOPS_PAT || '').trim();
const azBase = () => String(process.env.AZURE_DEVOPS_BASE_URL || 'https://dev.azure.com').replace(/\/+$/, '');
const mailOn = () => !!(mailUrl() && mailSecret());
const azureOn = () => !!azPat();
const remindersOn = () => mailOn() && String(process.env.AMB_REMINDERS || '').toLowerCase() !== 'off';
const status = () => ({ correo: mailOn(), azure: azureOn(), recordatorios: remindersOn() });

const isoNow = () => new Date().toISOString();
const errMsg = e => String((e && (e.msg || e.message)) || e || 'Error desconocido').slice(0, 300);

/* Un cambio a la vez por fila (y un recordatorio a la vez por incidente). */
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release; const mine = new Promise(r => { release = r; });
  const chain = prev.then(() => mine); locks.set(key, chain);
  await prev.catch(() => {});
  try { return await fn(); }
  finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}

async function getCfg() { const r = await store.getDoc('config', 'amb'); return L.mergeAmb(r && r.data); }

async function timed(url, opts) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 30000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'El servicio tardó demasiado en responder.' : 'No se pudo conectar con el servicio.'); }
  finally { clearTimeout(to); }
}

/* ---------- correo (Apps Script) ---------- */
/* Traduce lo que respondió el servicio de correo a una causa que se pueda corregir. */
function mailProblem(status, text, j) {
  const t = String(text || '');
  if (j && j.ok === false && j.error) {
    const e = String(j.error);
    if (/secreto/i.test(e)) return 'el servicio rechazó la clave: AMB_MAIL_SECRET en Render debe ser idéntica a la propiedad AMB_MAIL_SECRET del Apps Script.';
    if (/destinatario no permitido/i.test(e)) return 'el servicio rechazó algún destinatario (solo acepta @bancofinandina.com). Revisa los correos en Ambientes → Configuración.';
    if (/authorization|permission|permiso|autoriz/i.test(e)) return 'Google no autorizó el envío: abre el script, ejecuta la función «autorizar» y acepta el permiso; luego crea una nueva versión de la implementación. Detalle: ' + e.slice(0, 160);
    if (/quota|cuota|limit/i.test(e)) return 'se agotó la cuota diaria de correos de Google. Detalle: ' + e.slice(0, 160);
    return e.slice(0, 220);
  }
  if (/accounts\.google\.com|ServiceLogin|Sign in|Iniciar sesi/i.test(t)) return 'Google pidió iniciar sesión: en el Apps Script, «Implementar → Administrar implementaciones → Editar», pon «Quién tiene acceso: Cualquier persona», guarda como nueva versión y usa la URL /exec.';
  if (status === 404 || /No se encontr|not found|Error 404/i.test(t)) return 'la URL del script no existe (404): revisa AMB_MAIL_URL; debe ser la «URL de la aplicación web» que termina en /exec.';
  if (status === 401 || status === 403) return 'Google negó el acceso (' + status + '): la implementación debe tener acceso «Cualquier persona» y la URL debe terminar en /exec.';
  if (/<html|<!doctype/i.test(t)) return 'el script respondió una página de error en vez de JSON' + (/TypeError|ReferenceError|SyntaxError/.test(t) ? ' (error de código dentro del script: ábrelo y revisa «Ejecuciones»)' : ' (revisa que la URL sea la /exec de la implementación más reciente)') + '.';
  return 'respuesta inesperada del servicio de correo (' + status + ').';
}
async function sendMail(m) {
  if (!mailOn()) throw new Error('El envío de correo no está configurado en el servidor.');
  if (!/^https?:\/\/[^\s]+$/i.test(mailUrl())) throw new Error('Correo: AMB_MAIL_URL no es una dirección web válida. Debe ser la «URL de la aplicación web» completa (https://script.google.com/…/exec), no solo el ID.');
  let r;
  try {
    r = await timed(mailUrl(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: mailSecret(), to: m.to, subject: m.subject, body: m.text, htmlBody: m.html }) });
  } catch (e) { throw new Error('Correo: ' + e.message + (/\/exec\/?$/.test(mailUrl()) ? '' : ' Además, AMB_MAIL_URL no termina en /exec.')); }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (!r.ok || !j || j.ok !== true) {
    const why = mailProblem(r.status, t, j); console.error('Correo de Ambientes: ' + why + ' [HTTP ' + r.status + ']');
    throw new Error('Correo: ' + why);
  }
}
async function probarCorreo(to) {
  const dest = String(to || '').trim();
  if (!/^[^@\s,;]+@bancofinandina\.com$/i.test(dest)) throw { status: 400, msg: 'Escribe un correo @bancofinandina.com para la prueba.' };
  try { await sendMail({ to: dest, subject: 'Prueba de correo · QUQI_QA Ambientes', text: 'Si lees esto, el envío de correos de Ambientes funciona.', html: '<b>Si lees esto, el envío de correos de Ambientes funciona.</b>' }); }
  catch (e) { throw { status: 502, msg: errMsg(e) }; }
  return { ok: true };
}

/* ---------- Azure DevOps (escritura) ---------- */
async function azRequest(cfg, method, path, patchDoc) {
  const org = cfg.azure.org || String(process.env.AZURE_DEVOPS_ORG || '').trim(), proj = cfg.azure.proyecto;
  if (!org || !proj) throw new Error('Azure: falta la organización o el proyecto en la configuración de Ambientes.');
  let r;
  try {
    r = await timed(azBase() + '/' + encodeURIComponent(org) + '/' + encodeURIComponent(proj) + path, { method, redirect: 'manual',
      headers: { Authorization: 'Basic ' + Buffer.from(':' + azPat()).toString('base64'), 'Content-Type': 'application/json-patch+json', Accept: 'application/json' }, body: JSON.stringify(patchDoc) });
  } catch (e) { throw new Error('Azure: ' + e.message); }
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  if (r.status === 203 || r.status === 401 || (r.status >= 300 && r.status < 400)) throw new Error('Azure rechazó la llave (PAT): no es válida o venció.');
  if (r.status === 403) throw new Error('Azure: la llave (PAT) no tiene permiso para crear o editar work items (Work Items → Read & Write).');
  if (r.status === 404) throw new Error('Azure: no se encontró la organización o el proyecto.');
  return { status: r.status, ok: r.ok, json: j, text: t };
}
async function azCreateIssue(d, cfg) {
  const x = L.ambIssueDraft(d, cfg);
  const doc = [
    { op: 'add', path: '/fields/System.Title', value: x.titulo },
    { op: 'add', path: '/fields/System.Description', value: x.descripcion },
    { op: 'add', path: '/fields/System.AreaPath', value: x.area },
    { op: 'add', path: '/fields/System.IterationPath', value: x.iteracion },
    { op: 'add', path: '/fields/System.Tags', value: x.etiquetas },
    { op: 'add', path: '/fields/Custom.Flujofuncional', value: x.flujo }
  ];
  const path = '/_apis/wit/workitems/$' + encodeURIComponent(x.tipo) + '?api-version=7.1';
  let r = await azRequest(cfg, 'POST', path, x.asignado ? doc.concat([{ op: 'add', path: '/fields/System.AssignedTo', value: x.asignado }]) : doc);
  if (!r.ok && x.asignado && r.status === 400 && /assigned|identity|user/i.test(r.text || '')) r = await azRequest(cfg, 'POST', path, doc);   /* el responsable no existe en Azure: se crea sin asignar */
  if (!r.ok || !r.json || !r.json.id) throw new Error('Azure no creó el Issue' + (r.json && r.json.message ? ': ' + String(r.json.message).slice(0, 220) : ' (' + r.status + ').'));
  return String(r.json.id);
}
async function azCloseIssue(id, cfg) {
  const r = await azRequest(cfg, 'PATCH', '/_apis/wit/workitems/' + encodeURIComponent(id) + '?api-version=7.1', [{ op: 'add', path: '/fields/System.State', value: cfg.azure.estadoCierre || 'Cerrado' }]);
  if (!r.ok) throw new Error('Azure no cerró el Issue #' + id + (r.json && r.json.message ? ': ' + String(r.json.message).slice(0, 220) : ' (' + r.status + ').'));
}

/* ---------- escritura de documentos (con difusión a las pantallas abiertas) ---------- */
async function put(col, id, patch, broadcast) {
  const d = await store.mergeDoc(col, id, patch, 'sistema'); broadcast({ op: 'set', col, id, data: d.data, version: d.version }); return d.data;
}
async function add(col, data, broadcast) {
  const id = store.newId(), d = await store.setDoc(col, id, data, 'sistema'); broadcast({ op: 'set', col, id, data: d.data, version: d.version }); return id;
}
async function histOf(hojaId) {
  const r = await db.q("SELECT id, data FROM docs WHERE col='amb_hist' AND data->>'hojaId'=$1", [hojaId]);
  return r.rows.map(x => Object.assign({ id: x.id }, x.data));
}

/* ---------- procesos con efectos externos (se pueden repetir sin duplicar) ---------- */
async function procesarApertura(recId, broadcast) {
  const cfg = await getCfg(); let rec = (await store.getDoc('amb_hist', recId)).data; const out = { issue: rec.issue || '', issueEstado: '', correoEstado: '', errores: [] };
  const base = { hoja: rec.hoja, detalle: rec.detalle, desc: rec.desc };
  if (!rec.issue) {
    if (!azureOn()) { out.issueEstado = 'sin_config'; await put('amb_hist', recId, { issueEstado: 'sin_config', issueError: '' }, broadcast); }
    else {
      try { const id = await azCreateIssue(base, cfg); out.issue = id; out.issueEstado = 'ok'; rec = await put('amb_hist', recId, { issue: id, issueEstado: 'ok', issueError: '' }, broadcast); }
      catch (e) { console.error('Issue de Ambientes: ' + errMsg(e)); out.issueEstado = 'error'; out.errores.push(errMsg(e)); await put('amb_hist', recId, { issueEstado: 'error', issueError: errMsg(e) }, broadcast); }
    }
  } else out.issueEstado = 'ok';
  if (!rec.enviado) {
    if (!mailOn()) { out.correoEstado = 'sin_config'; await put('amb_hist', recId, { correoEstado: 'sin_config', correoError: '' }, broadcast); }
    else {
      try { await sendMail(L.ambMensaje('inc', Object.assign({}, base, { issue: out.issue }), cfg)); out.correoEstado = 'ok'; await put('amb_hist', recId, { enviado: true, enviadoEn: isoNow(), correoEstado: 'ok', correoError: '' }, broadcast); }
      catch (e) { out.correoEstado = 'error'; out.errores.push(errMsg(e)); await put('amb_hist', recId, { correoEstado: 'error', correoError: errMsg(e) }, broadcast); }
    }
  } else out.correoEstado = 'ok';
  return out;
}
async function procesarCierre(recId, broadcast) {
  const cfg = await getCfg(); let rec = (await store.getDoc('amb_hist', recId)).data; const out = { issue: rec.issue || '', issueEstado: '', correoEstado: '', errores: [] };
  const base = { hoja: rec.hoja, detalle: rec.detalle, desc: rec.desc, issue: rec.issue || '' };
  if (!rec.issue) out.issueEstado = 'sin_issue';
  else if (rec.issueCerrado) out.issueEstado = 'ok';
  else if (!azureOn()) { out.issueEstado = 'sin_config'; }
  else {
    try { await azCloseIssue(rec.issue, cfg); out.issueEstado = 'ok'; rec = await put('amb_hist', recId, { issueCerrado: true, issueEstado: 'ok', issueError: '' }, broadcast); }
    catch (e) { console.error('Issue de Ambientes: ' + errMsg(e)); out.issueEstado = 'error'; out.errores.push(errMsg(e)); await put('amb_hist', recId, { issueEstado: 'error', issueError: errMsg(e) }, broadcast); }
  }
  if (!rec.enviado) {
    if (!mailOn()) { out.correoEstado = 'sin_config'; await put('amb_hist', recId, { correoEstado: 'sin_config', correoError: '' }, broadcast); }
    else {
      try { await sendMail(L.ambMensaje('cierre', base, cfg)); out.correoEstado = 'ok'; await put('amb_hist', recId, { enviado: true, enviadoEn: isoNow(), correoEstado: 'ok', correoError: '' }, broadcast); }
      catch (e) { out.correoEstado = 'error'; out.errores.push(errMsg(e)); await put('amb_hist', recId, { correoEstado: 'error', correoError: errMsg(e) }, broadcast); }
    }
  } else out.correoEstado = 'ok';
  return out;
}

/* ---------- cambio de estado ---------- */
async function setEstado(user, b, broadcast) {
  const hojaId = String((b && b.hojaId) || ''), rk = String((b && b.rk) || '');
  const canon = L.AMB_VALIDOS.find(v => v === String((b && b.valor) || '').trim().toUpperCase());
  if (!canon) throw { status: 400, msg: 'Estado no válido. Usa SI, NO, OCASIONALMENTE o MUY INTERMITENTE.' };
  if (!store.ID_RE.test(hojaId) || !/^r\d{1,5}$/.test(rk)) throw { status: 400, msg: 'Fila inválida.' };
  return withLock(hojaId + '|' + rk, async () => {
    const hr = await store.getDoc('amb_hojas', hojaId), row = hr && hr.data && hr.data.tipo !== 'catalogo' && hr.data.rows && hr.data.rows[rk];
    if (!row) throw { status: 404, msg: 'No existe esa fila de Ambientes.' };
    const old = row.est, wasSI = L.ambIsSI(old), t = L.ambTransicion(old, canon);
    if (!t.cambia || (wasSI && t.valorH === 'SI')) return { ok: true, accion: 'sin_cambio' };
    const now = isoNow(), abre = t.abre && !wasSI, cierra = t.cierra && wasSI;
    const patch = { est: canon }; if (t.actualizaFecha) { patch.ult = now; patch.hist = t.valorH; } if (abre) patch.aviso = now;
    await put('amb_hojas', hojaId, { rows: { [rk]: patch } }, broadcast);
    const base = { hoja: hr.data.name, hojaId, rowKey: rk, detalle: row.det, desc: row.desc, autor: user.name };
    if (abre) {
      const id = await add('amb_hist', Object.assign({}, base, { falla: 'SI', fecha: now, issue: '', enviado: false, solventado: '' }), broadcast);
      const r = await procesarApertura(id, broadcast);
      return Object.assign({ ok: true, accion: 'abre', recId: id }, r);
    }
    if (cierra) {
      const open = (await histOf(hojaId)).filter(r => L.ambIsSI(r.falla) && !r.cierreEn && (r.rowKey ? r.rowKey === rk : r.detalle === row.det)).sort((a, c) => String(c.fecha).localeCompare(String(a.fecha)))[0] || null;
      const id = await add('amb_hist', Object.assign({}, base, { falla: 'NO (Solucionado)', fecha: now, issue: (open && open.issue) || '', solventado: 'SI', enviado: false, abre: open ? open.id : '' }), broadcast);
      if (open) await put('amb_hist', open.id, { cierreEn: now, cerradoPor: user.name }, broadcast);
      const r = await procesarCierre(id, broadcast);
      return Object.assign({ ok: true, accion: 'cierra', recId: id }, r);
    }
    return { ok: true, accion: 'estado' };
  });
}
/* Repite lo que falló (crear el Issue, cerrarlo o enviar el correo) sin duplicar lo que ya salió bien. */
async function reintentar(user, recId, broadcast) {
  if (!store.ID_RE.test(String(recId || ''))) throw { status: 400, msg: 'Registro inválido.' };
  const r = await store.getDoc('amb_hist', recId); if (!r) throw { status: 404, msg: 'No existe ese registro.' };
  return withLock('rec|' + recId, async () => {
    const out = L.ambIsSI(r.data.falla) ? await procesarApertura(recId, broadcast) : await procesarCierre(recId, broadcast);
    return Object.assign({ ok: true, accion: 'reintento', recId }, out);
  });
}

/* ---------- recordatorios automáticos ---------- */
async function recDesde() {
  const r = await db.q("SELECT value FROM meta WHERE key='amb_rec_desde'");
  if (r.rows[0] && r.rows[0].value && r.rows[0].value.iso) return r.rows[0].value.iso;
  const iso = isoNow();
  await db.q("INSERT INTO meta(key,value) VALUES ('amb_rec_desde', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ iso })]);
  return iso;
}
let running = false;
async function runReminders(broadcast) {
  if (!remindersOn() || running) return { enviados: 0, errores: 0 };
  running = true; let enviados = 0, errores = 0;
  try {
    const cfg = await getCfg(), desde = await recDesde(), now = isoNow();
    const hojas = (await store.listDocs('amb_hojas')).filter(r => r.data && r.data.tipo !== 'catalogo' && r.data.rows).map(r => Object.assign({ id: r.id }, r.data));
    const hist = (await store.listDocs('amb_hist')).map(r => Object.assign({ id: r.id }, r.data));
    for (const inc of L.ambOpenIncidents(hojas, hist, now, cfg.horasRecordatorio)) {
      /* Los incidentes que ya estaban abiertos cuando se activó el envío automático cuentan desde ese momento (no se manda un aluvión de recordatorios atrasados). */
      const desdeAviso = L.ambHorasDesde(inc.aviso > desde ? inc.aviso : desde, now);
      if (desdeAviso < cfg.horasRecordatorio) continue;
      await withLock(inc.hojaId + '|' + inc.rk, async () => {
        const fresh = (await store.getDoc('amb_hojas', inc.hojaId)), row = fresh && fresh.data.rows && fresh.data.rows[inc.rk];
        if (!row || !L.ambIsSI(row.est)) return;
        const prev = row.aviso || '', aviso = (prev || inc.inicio) > desde ? (prev || inc.inicio) : desde;
        if (L.ambHorasDesde(aviso, isoNow()) < cfg.horasRecordatorio) return;
        await put('amb_hojas', inc.hojaId, { rows: { [inc.rk]: { aviso: isoNow() } } }, broadcast);   /* se marca antes de enviar: si el servidor se reinicia no se duplica */
        try {
          await sendMail(L.ambMensaje('rec', { hoja: inc.hoja, detalle: inc.detalle, issue: (inc.rec && inc.rec.issue) || '', desc: inc.desc, horas: inc.horas }, cfg));
          if (inc.rec) await put('amb_hist', inc.rec.id, { nRec: (Number(inc.rec.nRec) || 0) + 1, ultimoRecordatorio: isoNow() }, broadcast);
          enviados++;
        } catch (e) {
          errores++; console.error('Recordatorio de Ambientes (' + inc.hoja + ' · ' + inc.detalle + '): ' + errMsg(e));
          await put('amb_hojas', inc.hojaId, { rows: { [inc.rk]: { aviso: prev } } }, broadcast).catch(() => {});   /* se reintenta en la próxima revisión */
        }
      });
    }
  } catch (e) { console.error('Revisión de recordatorios de Ambientes: ' + errMsg(e)); errores++; }
  finally { running = false; }
  return { enviados, errores };
}
let timer = null;
function startScheduler(broadcast) {
  if (!remindersOn() || timer) return;
  const every = Math.max(1, Math.floor(Number(process.env.AMB_REMINDER_MINUTES) || 10)) * 60000;
  recDesde().catch(() => {});
  setTimeout(() => runReminders(broadcast), 60000).unref();
  timer = setInterval(() => runReminders(broadcast), every); timer.unref();
}

module.exports = { normMailUrl, probarCorreo, status, setEstado, reintentar, runReminders, startScheduler, recDesde };
