'use strict';
/* Cargue de proyectos en QA (portado del Agente QA).
   Requerimientos (Drive o archivo subido) → extracción de HU → la IA diseña los casos de prueba → Azure DevOps (Feature / User Story / Test Plan / Test Cases).
   Todo corre en segundo plano como «trabajos» con un registro (log) que la pantalla consulta cada pocos segundos. Solo lo usa el administrador.

   Variables de entorno (todas secretas; nunca van en el código):
     AZURE_DEVOPS_PAT_WRITE (o AZURE_DEVOPS_PAT)   llave con Work Items y Test Management en Read & Write
     AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT        organización y proyecto (por defecto BancoFinandina / Gestion Proyectos)
     QA_AREA_PATH, QA_ITERATION_PATH, QA_TEST_CASE_STATE, QA_DEFAULT_TAG
     GEMINI_API_KEY, GEMINI_MODEL                  IA (GEMINI_MODEL admite varios modelos separados por coma: principal,respaldo)
     GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN, DRIVE_ROOT_FOLDER_ID   Drive (ver setup_google_auth.py del agente) */
const store = require('./store');
const db = require('./db');
const X = require('./cargue_extract');
const drive = require('./cargue_drive');

const env = k => String(process.env[k] || '').trim();
const isoNow = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errMsg = e => String((e && (e.msg || e.message)) || e || 'Error desconocido').slice(0, 400);
const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const escH = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const az = () => ({
  org: env('AZURE_DEVOPS_ORG') || 'BancoFinandina', project: env('CARGUE_AZURE_PROJECT') || 'Gestion Proyectos',   /* no se usa AZURE_DEVOPS_PROJECT: ese es el proyecto por defecto de los bugs y puede ser otro */
  pat: env('AZURE_DEVOPS_PAT_WRITE') || env('AZURE_DEVOPS_PAT'), base: (env('AZURE_DEVOPS_BASE_URL') || 'https://dev.azure.com').replace(/\/+$/, ''),
  area: env('QA_AREA_PATH') || 'Gestion Proyectos\\QA', iter: env('QA_ITERATION_PATH') || 'Gestion Proyectos\\Backlog',
  state: env('QA_TEST_CASE_STATE'), tag: env('QA_DEFAULT_TAG') || '041. Mejoras Apertura FlexiDigital+'
});
const geminiKey = () => env('GEMINI_API_KEY');
const iaOn = () => !!geminiKey();
const MODELO_DEFECTO = 'gemini-3.8-flash';
/* Modelos a probar, en orden: los de GEMINI_MODEL y, al final, el vigente por defecto (si un modelo ya no existe para la llave, se salta al siguiente). */
const modelos = () => { const l = (env('GEMINI_MODEL') || '').split(',').map(s => s.trim()).filter(Boolean); if (!l.includes(MODELO_DEFECTO)) l.push(MODELO_DEFECTO); return l; };
const status = () => { const a = az(); return { azure: !!a.pat, ia: iaOn(), drive: drive.configured(), carpetaRaiz: drive.rootFolderId(), proyectoAzure: a.project, area: a.area, iteracion: a.iter, modelo: modelos()[0] }; };

/* ---------- Azure DevOps ---------- */
async function azFetch(method, path, body, ct) {
  const a = az(); if (!a.pat) throw new Error('Falta la llave de Azure DevOps (AZURE_DEVOPS_PAT_WRITE o AZURE_DEVOPS_PAT).');
  const url = a.base + '/' + encodeURIComponent(a.org) + '/' + encodeURIComponent(a.project) + '/' + path;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 45000);
  let r;
  try {
    r = await fetch(url, { method, redirect: 'manual', signal: ctl.signal, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: 'Basic ' + Buffer.from(':' + a.pat).toString('base64'), 'Content-Type': ct || 'application/json', Accept: 'application/json' } });
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'Azure DevOps tardó demasiado en responder.' : 'No se pudo conectar con Azure DevOps.'); }
  finally { clearTimeout(to); }
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  if (r.status === 203 || r.status === 401 || (r.status >= 300 && r.status < 400)) throw new Error('Azure rechazó la llave (PAT): no es válida o venció.');
  if (r.status === 403) throw new Error('Azure: la llave (PAT) no tiene permiso (necesita Work Items y Test Management en Read & Write).');
  if (r.status === 404) throw new Error('Azure no encontró la organización «' + a.org + '» o el proyecto «' + a.project + '» (404). Revisa AZURE_DEVOPS_ORG y CARGUE_AZURE_PROJECT en Render.');
  return { status: r.status, ok: r.ok, json, text, headers: r.headers };
}
const azMsg = r => String((r.json && (r.json.message || r.json.Message)) || r.text || ('HTTP ' + r.status)).replace(/\s+/g, ' ').slice(0, 300);
const wiUrl = id => { const a = az(); return a.base + '/' + encodeURIComponent(a.org) + '/' + encodeURIComponent(a.project) + '/_apis/wit/workitems/' + id; };
const PATCH = 'application/json-patch+json';

async function buscarFeatureId(titulo) {
  const a = az(), t = String(titulo).replace(/'/g, "''");
  const r = await azFetch('POST', '_apis/wit/wiql?api-version=7.1', { query: "SELECT [System.Id], [System.Title] FROM workitems WHERE [System.TeamProject] = '" + a.project.replace(/'/g, "''") + "' AND ([System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Epic') AND [System.Title] = '" + t + "'" });
  if (!r.ok) throw new Error('No se pudo consultar el Feature en Azure: ' + azMsg(r));
  const w = (r.json && r.json.workItems) || []; return w.length ? w[0].id : null;
}
async function buscarTestPlan(nombre) {
  const objetivo = flat(nombre).toLowerCase(); let token = '';
  for (let i = 0; i < 50; i++) {
    const r = await azFetch('GET', '_apis/testplan/plans?api-version=7.1' + (token ? '&continuationToken=' + encodeURIComponent(token) : ''));
    if (!r.ok) throw new Error('No se pudieron consultar los Test Plans: ' + azMsg(r));
    for (const p of (r.json && r.json.value) || []) if (flat(p.name).toLowerCase() === objetivo) return { id: p.id, root: (p.rootSuite || {}).id || null };
    token = r.headers.get('x-ms-continuationtoken') || ''; if (!token) return null;
  }
  return null;
}
async function listarUserStories(featureId) {
  const r = await azFetch('POST', '_apis/wit/wiql?api-version=7.1', { query: "SELECT [System.Id] FROM workitemLinks WHERE [Source].[System.Id] = " + (+featureId) + " AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' AND [Target].[System.WorkItemType] = 'User Story' MODE (MustContain)" });
  if (!r.ok) throw new Error('No se pudieron consultar las User Stories del Feature #' + featureId + ': ' + azMsg(r));
  const ids = ((r.json && r.json.workItemRelations) || []).filter(x => x.rel && x.target && x.target.id !== featureId).map(x => x.target.id);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const b = await azFetch('POST', '_apis/wit/workitemsbatch?api-version=7.1', { ids: ids.slice(i, i + 200), $expand: 'relations' });
    if (!b.ok) throw new Error('No se pudieron leer las User Stories: ' + azMsg(b));
    for (const wi of (b.json && b.json.value) || []) out.push({ id: wi.id, titulo: (wi.fields || {})['System.Title'] || '', tiene_casos: (wi.relations || []).some(x => x.rel === 'Microsoft.VSTS.Common.TestedBy-Forward') });
  }
  return out;
}
async function crearFeature(titulo, tag) {
  const a = az();
  const r = await azFetch('POST', '_apis/wit/workitems/$Feature?api-version=7.1', [
    { op: 'add', path: '/fields/System.Title', value: titulo }, { op: 'add', path: '/fields/System.AreaPath', value: a.area }, { op: 'add', path: '/fields/System.IterationPath', value: a.iter },
    { op: 'add', path: '/fields/System.Tags', value: tag || a.tag }, { op: 'add', path: '/fields/Microsoft.VSTS.Common.ValueArea', value: 'CRM' },
    { op: 'add', path: '/fields/Custom.e31bddb8-3aad-44f9-97c3-908443d49f86', value: 'Proyecto' }, { op: 'add', path: '/fields/Custom.OrigenGerencia', value: 'Riesgos' }, { op: 'add', path: '/fields/Custom.Flujofuncional', value: 'QA' }], PATCH);
  if (r.ok && r.json && r.json.id) return { id: r.json.id };
  return { error: azMsg(r) };
}
async function crearUserStory(hu, parentId, tag) {
  const a = az();
  const desc = '<div><b>QUIERO:</b> ' + escH(hu.quiero) + '</div><div><b>PARA:</b> ' + escH(hu.para) + '</div><br><div><b>Implementación:</b> Ambiente QA</div>';
  const crit = '<ul>' + hu.criterios.map(c => '<li>' + escH(c) + '</li>').join('') + '</ul>';
  const r = await azFetch('POST', '_apis/wit/workitems/$User%20Story?api-version=7.1', [
    { op: 'add', path: '/fields/System.Title', value: (hu.origen_hu + ' - ' + hu.titulo_hu).slice(0, 255) }, { op: 'add', path: '/fields/System.AreaPath', value: a.area }, { op: 'add', path: '/fields/System.IterationPath', value: a.iter },
    { op: 'add', path: '/fields/System.Description', value: desc }, { op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: crit }, { op: 'add', path: '/fields/System.Tags', value: tag || a.tag },
    { op: 'add', path: '/fields/Microsoft.VSTS.Common.ValueArea', value: 'Business' }, { op: 'add', path: '/fields/Custom.e31bddb8-3aad-44f9-97c3-908443d49f86', value: 'Evolutivo' },
    { op: 'add', path: '/fields/Custom.OrigenGerencia', value: 'G. Transf. Digital' }, { op: 'add', path: '/fields/Custom.Flujofuncional', value: 'QA' },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: wiUrl(parentId) } }], PATCH);
  if (r.ok && r.json && r.json.id) return { id: r.json.id };
  return { error: azMsg(r) };
}
async function crearTestCase(titulo, pasos, usId, tag) {
  const a = az();
  let xml = '<steps id="0" last="' + pasos.length + '">';
  pasos.forEach((p, i) => { xml += '<step id="' + (i + 1) + '" type="ValidateStep"><parameterizedString isformatted="true">' + escH(p.accion) + '</parameterizedString><parameterizedString isformatted="true">' + escH(p.esperado) + '</parameterizedString><description/></step>'; });
  xml += '</steps>';
  const doc = [{ op: 'add', path: '/fields/System.Title', value: String(titulo).slice(0, 255) }, { op: 'add', path: '/fields/System.AreaPath', value: a.area }, { op: 'add', path: '/fields/System.IterationPath', value: a.iter },
    { op: 'add', path: '/fields/System.Tags', value: tag || a.tag }, { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: xml },
    /* Vínculo «Tests» (Test Case → User Story): el que usan las suites por requisito para mostrar los casos de cada HU. */
    { op: 'add', path: '/relations/-', value: { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: wiUrl(usId) } }];
  if (a.state) doc.push({ op: 'add', path: '/fields/System.State', value: a.state });
  const r = await azFetch('POST', '_apis/wit/workitems/$Test%20Case?api-version=7.1', doc, PATCH);
  if (r.ok && r.json && r.json.id) return { id: r.json.id };
  return { error: azMsg(r) };
}
async function crearTestPlan(nombre) {
  const a = az();
  const r = await azFetch('POST', '_apis/testplan/plans?api-version=7.1', { name: nombre, areaPath: a.area, iteration: a.iter });
  if (!r.ok) return { error: azMsg(r) };
  return { id: r.json.id, root: (r.json.rootSuite || {}).id || null };
}
async function crearSuiteRequisito(planId, parentSuiteId, reqId, nombre) {
  const r = await azFetch('POST', '_apis/testplan/Plans/' + planId + '/suites?api-version=7.1', { suiteType: 'requirementTestSuite', name: String(nombre).slice(0, 255), requirementId: reqId, parentSuite: { id: parentSuiteId } });
  return r.ok ? { ok: true } : { error: azMsg(r) };
}

/* ---------- IA (Gemini) ---------- */
const TRANSITORIOS = ['503', '429', 'unavailable', 'resource_exhausted', 'overloaded', 'high demand', 'timeout', '500'];
const NO_MODELO = ['404', 'not_found', 'no longer available'];
let geminiIdx = 0;
async function geminiOnce(prompt, model, maxTokens) {
  const base = env('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta';
  const gen = { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: maxTokens };
  if (/gemini-2\.5-flash/i.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 150000);
  let r;
  try { r = await fetch(base + '/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gen }) }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'timeout de la IA' : 'No se pudo conectar con la IA'); }
  finally { clearTimeout(to); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) {} throw new Error(r.status + ' ' + (r.status === 429 ? 'RESOURCE_EXHAUSTED ' : r.status === 503 ? 'UNAVAILABLE ' : r.status === 404 ? 'NOT_FOUND ' : '') + String(m).slice(0, 160)); }
  const j = await r.json(), parts = (((j.candidates || [])[0] || {}).content || {}).parts;
  return Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
}
/* Devuelve el texto de la IA. Reintenta (5, 10, 20, 40 s) ante errores transitorios y pasa al modelo de respaldo si el principal no responde. */
async function generarTexto(prompt, maxTokens) {
  if (!iaOn()) throw new Error('La IA no está configurada (falta GEMINI_API_KEY en Render).');
  maxTokens = maxTokens || 16000;
  for (;;) {
    const lista = modelos();
    geminiIdx = Math.min(geminiIdx, lista.length - 1);
    const modelo = lista[geminiIdx], ultimo = geminiIdx >= lista.length - 1, max = ultimo ? 4 : 1;
    let lastErr = null;
    for (let i = 0; i <= max; i++) {
      try { return await geminiOnce(prompt, modelo, maxTokens); }
      catch (e) {
        lastErr = e; const t = String(e.message).toLowerCase();
        if (NO_MODELO.some(m => t.includes(m)) && !ultimo) break;
        if (!TRANSITORIOS.some(m => t.includes(m))) throw e;
        if (i === max) break;
        await sleep((+env('CARGUE_ESPERA_MS') || 5000) * Math.pow(2, i));
      }
    }
    if (ultimo) throw lastErr;
    geminiIdx++;
  }
}
const ia = async prompt => { const t = await generarTexto(prompt); return parseArray(t); };

function parseArray(contenido) {
  let c = String(contenido || '').trim().replace(/```json/g, '').replace(/```/g, '').trim();
  const ini = c.indexOf('['); if (ini === -1) return [];
  const fin = c.lastIndexOf(']') + 1;
  if (fin > ini) {
    try { return JSON.parse(c.slice(ini, fin)); } catch (_) {}
    try { return JSON.parse(c.slice(ini, fin).replace(/\}\s*\{/g, '},{')); } catch (_) {}
  }
  /* Respuesta cortada: se rescatan los casos completos que alcanzaron a llegar. */
  const cands = []; for (let i = ini + 1; i < c.length; i++) if (c[i] === '}') cands.push(i);
  for (const pos of cands.slice(-60).reverse()) { try { const r = JSON.parse(c.slice(ini, pos + 1) + ']'); if (r && r.length) return r; } catch (_) {} }
  return [];
}
const PROMPT_CASOS = hu => `
Actúa, analiza y genera como un QA Lead Senior especializado en pruebas funcionales, no funcionales,
pruebas de romper el sistema, teniendo en cuenta la posibilidad de conexión y desconexión de apis,
internet o AS400, errores o fallos desde la app, portal o aplicativo a probar.
Ten en cuenta que si lleva varios perfiles, se deben crear casos de prueba con estas combinaciones y robustez de software.

Tu tarea es generar un plan de pruebas técnico y detallado para la siguiente Historia de Usuario:

- QUIERO: ${hu.quiero}
- PARA: ${hu.para}
- CRITERIOS DE ACEPTACIÓN: ${hu.criterios.join(', ')}

Analiza bajo estas 4 categorías (Caminos Exitosos, Control de Errores, Pruebas de Resiliencia, Escenarios Destructivos/Edge Cases).

REGLA DE FORMATO ESTRICTA:
Devuelve ÚNICAMENTE un arreglo JSON puro. NO incluyas el nombre de las categorías en los títulos ni uses formato markdown.
Usa el siguiente formato:
[
  {
    "titulo": "Nombre descriptivo y técnico del escenario",
    "pasos": [
      {"accion": "Lo que el usuario hace en la interfaz", "esperado": "Lo que el sistema debe responder"}
    ]
  }
]
`;
function casosValidos(arr) {
  return (Array.isArray(arr) ? arr : []).filter(c => c && typeof c === 'object' && flat(c.titulo)).slice(0, 60).map(c => ({
    titulo: flat(c.titulo).slice(0, 250),
    pasos: (Array.isArray(c.pasos) ? c.pasos : []).filter(p => p && typeof p === 'object' && (flat(p.accion) || flat(p.esperado))).slice(0, 40).map(p => ({ accion: flat(p.accion), esperado: flat(p.esperado) }))
  })).filter(c => c.pasos.length);
}
async function disenarCasos(hu) {
  try {
    const casos = casosValidos(parseArray(await generarTexto(PROMPT_CASOS(hu))));
    return casos.length ? { casos } : { casos: [], error: 'La IA respondió, pero no devolvió un arreglo JSON de casos de prueba.' };
  } catch (e) { return { casos: [], error: errMsg(e) }; }
}

/* ---------- validación de lo que llega del navegador ---------- */
function historiasValidas(arr) {
  if (!Array.isArray(arr) || !arr.length) throw { status: 400, msg: 'No hay Historias de Usuario para cargar.' };
  if (arr.length > 150) throw { status: 400, msg: 'Demasiadas Historias de Usuario (máximo 150 por cargue).' };
  const cut = (s, n) => flat(s).slice(0, n);
  return arr.map(h => {
    if (!h || typeof h !== 'object') throw { status: 400, msg: 'Historia de Usuario inválida.' };
    const x = { origen_hu: cut(h.origen_hu, 120), titulo_hu: cut(h.titulo_hu, 200) || 'Sin Título', quiero: cut(h.quiero, 4000), para: cut(h.para, 4000), criterios: (Array.isArray(h.criterios) ? h.criterios : []).slice(0, 80).map(c => cut(c, 2000)).filter(Boolean) };
    if (!x.origen_hu) x.origen_hu = 'HU';
    return x;
  });
}
const nombreProyecto = s => { const n = flat(s).slice(0, 200); if (!n) throw { status: 400, msg: 'Falta el nombre del proyecto.' }; return n; };
const tagDe = n => n.replace(/[;,]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- trabajos en segundo plano ---------- */
const jobs = new Map(), running = new Set();
const MAX_LOG = 1500;
function newJob(user, tipo, proyecto) {
  const job = { id: store.newId(), tipo, proyecto, usuario: user.name || user.username, estado: 'corriendo', log: [], inicio: isoNow(), fin: null, resultado: null };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (j.fin && Date.now() - Date.parse(j.fin) > 3 * 3600 * 1000) jobs.delete(id);
  return job;
}
const jlog = (job, m) => { job.log.push(m); if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG); };
async function saveHist(job) {
  try { await store.setDoc('cargue_hist', job.id, { tipo: job.tipo, proyecto: job.proyecto, usuario: job.usuario, estado: job.estado, inicio: job.inicio, fin: job.fin, resumen: job.tipo === 'generar' ? (job.resultado || null) : { historias: job.resultado && job.resultado.historias ? job.resultado.historias.length : 0, usado: job.resultado && job.resultado.usado || null }, log: job.log.slice(-400) }, 'sistema'); }
  catch (e) { console.error('Cargue: no se pudo guardar el historial: ' + errMsg(e)); }
}
function launch(job, key, fn) {
  if (key) running.add(key);
  (async () => {
    try { job.resultado = await fn(job); job.estado = job.resultado && job.resultado.errores ? 'con_errores' : 'ok'; }
    catch (e) { jlog(job, '❌ ' + errMsg(e)); job.estado = 'error'; }
    finally { job.fin = isoNow(); if (key) running.delete(key); await saveHist(job); }
  })();
  return job.id;
}
async function init() {   /* Al arrancar: los cargues que quedaron «corriendo» (por un reinicio) pasan a «interrumpido». */
  try { await db.q("UPDATE docs SET data = jsonb_set(data, '{estado}', '\"interrumpido\"'), version = version + 1 WHERE col='cargue_hist' AND data->>'estado'='corriendo'"); } catch (e) { console.error('Cargue init: ' + errMsg(e)); }
}

async function estadoAzure(proyecto) {
  const featureId = await buscarFeatureId(proyecto);
  const plan = featureId ? await buscarTestPlan(proyecto) : null;
  return { featureId, plan, modo: !featureId ? 'completo' : plan ? 'casos' : 'bloqueado' };
}

/* Analizar un proyecto: estado en Azure + lectura de los archivos de requerimientos + HU detectadas. */
function analizar(user, p) {
  const proyecto = nombreProyecto(p.proyecto), fuente = p.fuente === 'archivo' ? 'archivo' : 'drive';
  const key = 'a:' + proyecto.toLowerCase();
  if (running.has(key) || running.has('g:' + proyecto.toLowerCase())) throw { status: 409, msg: 'Ese proyecto ya tiene un proceso en curso.' };
  let carpeta = '', archivo = null;
  if (fuente === 'drive') { carpeta = String(p.carpetaId || ''); if (!/^[A-Za-z0-9_-]{10,100}$/.test(carpeta)) throw { status: 400, msg: 'Carpeta de Drive inválida.' }; }
  else {
    const nombre = String(p.archivoNombre || '').replace(/[\\/]/g, '_').slice(0, 200), buf = Buffer.from(String(p.archivoB64 || ''), 'base64');
    if (!nombre || !X.SUPPORTED.includes(X.extOf(nombre))) throw { status: 400, msg: 'Sube un archivo .xlsx, .md, .txt, .pdf o .pptx.' };
    if (!buf.length || buf.length > 10 * 1024 * 1024) throw { status: 400, msg: 'El archivo debe pesar entre 1 byte y 10 MB.' };
    archivo = { nombre, buf };
  }
  const job = newJob(user, 'analizar', proyecto);
  return launch(job, key, async j => {
    const L = m => jlog(j, m), res = { proyecto, fuente, archivos: [], usado: null, historias: [], featureId: null, plan: null, modo: null, azureError: '' };
    if (az().pat) {
      try { Object.assign(res, await estadoAzure(proyecto)); L(res.featureId ? '🔎 Ya existe el Feature #' + res.featureId + (res.plan ? ' y el Test Plan #' + res.plan.id + ': solo se habilita generar casos de prueba.' : ', pero no se encontró un Test Plan llamado «' + proyecto + '»: se bloquea para no duplicar a medias.') : '🔎 El proyecto aún no existe en Azure DevOps: se hará el flujo completo.'); }
      catch (e) { res.azureError = errMsg(e); L('⚠️ ' + res.azureError); }
    } else L('⚠️ Azure DevOps sin configurar: solo se puede previsualizar.');
    let archivos;
    if (fuente === 'drive') { L('📂 Buscando el archivo de requerimientos en Drive…'); archivos = await drive.findRequirementFiles(carpeta); if (!archivos.length) { L('⚠️ No se encontró un archivo .xlsx/.md/.pdf/.pptx de requerimientos en esa carpeta.'); return res; } }
    else archivos = [{ name: archivo.nombre, buf: archivo.buf }];
    res.archivos = archivos.map(a => a.name); L('📄 Archivo(s) detectado(s): ' + res.archivos.join(', '));
    for (const a of archivos) {
      try {
        const buf = a.buf || await drive.download(a.id);
        const h = await X.extraerHistorias(a.name, buf, { ia: iaOn() ? ia : null, log: L });
        if (h.length) { res.historias = X.sanear(h); res.usado = a.name; L('✅ ' + res.historias.length + ' Historia(s) de Usuario en «' + a.name + '».'); break; }
        L('ℹ️ «' + a.name + '» no contiene Historias de Usuario' + (archivos.length > 1 ? '; pruebo con el siguiente archivo.' : '.'));
      } catch (e) { L('❌ No se pudo leer «' + a.name + '»: ' + errMsg(e)); }
    }
    if (!res.historias.length) L('⚠️ No se detectaron HU. Revisa que el archivo traiga las historias (Yo como / Quiero / Para / Criterios de aceptación).');
    return res;
  });
}

/* Generar en Azure DevOps: flujo completo (Feature + HU + Test Plan + casos) o solo casos de prueba. */
function generar(user, p) {
  const proyecto = nombreProyecto(p.proyecto), modo = p.modo === 'casos' ? 'casos' : 'completo', historias = historiasValidas(p.historias), tag = tagDe(proyecto);
  if (!az().pat) throw { status: 400, msg: 'Azure DevOps no está configurado (falta AZURE_DEVOPS_PAT_WRITE).' };
  if (!iaOn()) throw { status: 400, msg: 'La IA no está configurada (falta GEMINI_API_KEY).' };
  const key = 'g:' + proyecto.toLowerCase();
  if (running.has(key) || running.has('a:' + proyecto.toLowerCase())) throw { status: 409, msg: 'Ese proyecto ya tiene un proceso en curso.' };
  if (running.size >= 2) throw { status: 429, msg: 'Ya hay 2 cargues en curso; espera a que termine alguno.' };
  const job = newJob(user, 'generar', proyecto);
  return launch(job, key, async j => {
    const L = m => jlog(j, m), r = { modo, featureId: null, planId: null, historias: historias.length, userStories: 0, casos: 0, omitidas: 0, errores: 0 };
    const casosPara = async pares => {
      for (const [usId, hu] of pares) {
        L('🧠 Diseñando casos para «' + hu.titulo_hu + '»…');
        const d = await disenarCasos(hu);
        if (d.error) { r.errores++; L('   ⚠️ No se generaron casos para «' + hu.titulo_hu + '»: ' + d.error); continue; }
        let n = 0;
        for (const tc of d.casos) {
          const c = await crearTestCase(tc.titulo, tc.pasos, usId, tag);
          if (c.id) { n++; r.casos++; L('   ✅ [' + hu.origen_hu + '] Test Case #' + c.id + ': ' + tc.titulo); }
          else { r.errores++; L('   ❌ Falló el Test Case «' + tc.titulo + '»: ' + c.error); }
        }
        L('   ' + n + '/' + d.casos.length + ' casos creados para «' + hu.titulo_hu + '» (User Story #' + usId + ').');
      }
    };
    const est = await estadoAzure(proyecto);   /* se vuelve a consultar: pudo cambiar desde la previsualización */
    if (modo === 'completo') {
      if (est.featureId) throw new Error('Ya existe el Feature #' + est.featureId + ' en Azure DevOps para «' + proyecto + '»: no se crea de nuevo (usa «Solo casos de prueba» si ya tiene Test Plan).');
      const f = await crearFeature(proyecto, tag);
      if (!f.id) throw new Error('No se pudo crear el Feature: ' + f.error);
      r.featureId = f.id; L('✅ Feature #' + f.id + ' creado para «' + proyecto + '».');
      const creadas = [];
      for (const hu of historias) {
        const us = await crearUserStory(hu, f.id, tag);
        if (!us.id) { r.errores++; L('❌ Error creando User Story «' + hu.titulo_hu + '»: ' + us.error); continue; }
        creadas.push([us.id, hu]); r.userStories++; L('🔗 User Story #' + us.id + ' creada: ' + hu.titulo_hu);
      }
      let confirmado = false;
      const tp = await crearTestPlan(proyecto);
      if (tp.error) { r.errores++; L('❌ No se pudo crear el Test Plan: ' + tp.error); }
      else {
        r.planId = tp.id; L('📋 Test Plan «' + proyecto + '» creado (ID #' + tp.id + ').');
        if (!creadas.length) L('   ⚠️ No hay User Stories creadas para agregar al Test Plan.');
        else if (!tp.root) L('   ⚠️ El Test Plan se creó pero no se detectó su suite raíz; agrega las HU a una suite a mano en Azure DevOps.');
        else {
          let ok = 0;
          for (const [usId, hu] of creadas) { const s = await crearSuiteRequisito(tp.id, tp.root, usId, hu.titulo_hu); if (s.ok) ok++; else { r.errores++; L('   ❌ No se pudo agregar «' + hu.titulo_hu + '» al Test Plan: ' + s.error); } }
          L('   ' + (ok ? '✅' : '❌') + ' ' + ok + '/' + creadas.length + ' User Story(s) agregadas al Test Plan (una suite de requisitos por cada una).'); confirmado = ok > 0;
        }
      }
      if (!confirmado) L('⏭️ Se omite la generación de casos de prueba porque el Test Plan no quedó confirmado.');
      else { L('🧪 Test Plan confirmado — generando casos de prueba con la IA…'); await casosPara(creadas); }
    } else {
      if (!est.featureId || !est.plan) throw new Error(!est.featureId ? 'No existe el Feature «' + proyecto + '» en Azure DevOps: usa el flujo completo.' : 'Existe el Feature #' + est.featureId + ' pero no un Test Plan llamado «' + proyecto + '»: créalo a mano para no duplicar nada.');
      r.featureId = est.featureId; r.planId = est.plan.id;
      const ex = await listarUserStories(est.featureId), porTitulo = new Map(ex.map(e => [flat(e.titulo).toLowerCase(), e])), pares = [];
      for (const hu of historias) {
        const esp = flat(hu.origen_hu + ' - ' + hu.titulo_hu).toLowerCase();
        const e = porTitulo.get(esp) || ex.find(x => flat(x.titulo).toLowerCase().includes(flat(hu.titulo_hu).toLowerCase()));
        if (!e) { r.errores++; L('⚠️ No encontré en Azure DevOps la User Story «' + hu.titulo_hu + '» del Feature #' + est.featureId + '.'); }
        else if (e.tiene_casos) { r.omitidas++; L('⏭️ «' + hu.titulo_hu + '» (#' + e.id + ') ya tiene casos de prueba — se omite.'); }
        else { r.userStories++; pares.push([e.id, hu]); }
      }
      L('🧪 Generando casos de prueba para ' + pares.length + ' User Story(s) del Feature #' + est.featureId + '…');
      await casosPara(pares);
    }
    L('🏁 Proceso terminado: ' + r.casos + ' caso(s) de prueba, ' + r.userStories + ' User Story(s)' + (r.errores ? ', ' + r.errores + ' con problemas (revisa el registro)' : '') + '.');
    return r;
  });
}

const publico = (j, desde) => ({ id: j.id, tipo: j.tipo, proyecto: j.proyecto, estado: j.estado, inicio: j.inicio, fin: j.fin, total: j.log.length, log: j.log.slice(Math.max(0, +desde || 0)), resultado: j.estado === 'corriendo' ? null : j.resultado });
const getJob = (id, desde) => { const j = jobs.get(String(id)); return j ? publico(j, desde) : null; };
async function historial() {
  const r = await db.q("SELECT id, data FROM docs WHERE col='cargue_hist' ORDER BY (data->>'inicio') DESC LIMIT 60");
  return r.rows.map(x => { const d = x.data; return { id: x.id, tipo: d.tipo, proyecto: d.proyecto, usuario: d.usuario, estado: d.estado, inicio: d.inicio, fin: d.fin, resumen: d.resumen }; });
}
async function historialDetalle(id) { const d = await store.getDoc('cargue_hist', String(id)); return d ? Object.assign({ id: d.id }, d.data) : null; }
async function carpetas(raiz) {
  const id = String(raiz || drive.rootFolderId()).trim();
  if (!id) throw { status: 400, msg: 'Falta el ID de la carpeta raíz de Drive (DRIVE_ROOT_FOLDER_ID en Render, o escríbelo en la pantalla).' };
  try { return { raiz: id, carpetas: await drive.listChildren(id, true) }; } catch (e) { throw { status: 502, msg: errMsg(e) }; }
}

module.exports = { status, init, analizar, generar, getJob, historial, historialDetalle, carpetas, parseArray };
