'use strict';
/* Conexión de SOLO LECTURA a Azure DevOps (work items). La llave (PAT) vive únicamente en el servidor:
   AZURE_DEVOPS_ORG, AZURE_DEVOPS_PAT y, opcional, AZURE_DEVOPS_PROJECT (proyecto de Azure por defecto). */
const store = require('./store');

const API = '7.1';
const MAX_BUGS = 1500;
const base = () => String(process.env.AZURE_DEVOPS_BASE_URL || 'https://dev.azure.com').replace(/\/+$/, '');
const org = () => String(process.env.AZURE_DEVOPS_ORG || '').trim();
const pat = () => String(process.env.AZURE_DEVOPS_PAT || '').trim();
const defaultProject = () => String(process.env.AZURE_DEVOPS_PROJECT || '').trim();
const bugTypes = () => String(process.env.AZURE_BUG_TYPES || 'Bug').split(',').map(s => s.trim()).filter(Boolean);
const testProject = () => String(process.env.AZURE_TEST_PROJECT || '').trim() || defaultProject();
const enabled = () => !!(org() && pat());
const syncMinutes = () => Math.max(5, Math.floor(Number(process.env.AZURE_SYNC_MINUTES) || 30));

const err = (status, msg, code) => ({ status, msg, code: code || 'azure' });
const bad = msg => err(400, msg, 'bad_request');

/* ---------- datos de entrada ---------- */
function cleanCfg(c) {
  c = c || {};
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const out = { proyecto: s(c.proyecto, 128), area: s(c.area, 300), iteracion: s(c.iteracion, 300), tag: s(c.tag, 100), padre: '' };
  const pd = String(c.padre == null ? '' : c.padre).replace(/^#/, '').trim();
  if (pd) { if (!/^\d{1,9}$/.test(pd)) throw bad('El ID del padre debe ser un número (por ejemplo 12345).'); out.padre = pd; }
  if (out.proyecto && !/^[\p{L}\p{N} ._()&\-]{1,128}$/u.test(out.proyecto)) throw bad('El nombre del proyecto de Azure tiene caracteres no válidos.');
  if (!out.area && !out.iteracion && !out.tag && !out.padre) throw bad('Indica al menos un dato para identificar los bugs: área, iteración, etiqueta o padre.');
  return out;
}
function projectOf(cfg) {
  const p = cfg.proyecto || defaultProject();
  if (!p) throw bad('Falta el proyecto de Azure: escríbelo en el vínculo del proyecto o configura AZURE_DEVOPS_PROJECT en Render.');
  return p;
}
const q = s => String(s).replace(/'/g, "''");
/* Los paths de Azure empiezan por el nombre del proyecto; si no lo traen, se lo agregamos. */
function fullPath(proj, p) {
  let x = String(p).replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
  if (x.toLowerCase() !== proj.toLowerCase() && !x.toLowerCase().startsWith(proj.toLowerCase() + '\\')) x = proj + '\\' + x;
  return x;
}
const under = (value, path) => { const v = String(value || '').toLowerCase(), p = path.toLowerCase(); return v === p || v.startsWith(p + '\\'); };

/* ---------- HTTP ---------- */
async function call(method, proj, urlPath, body, forbiddenMsg) {
  if (!enabled()) throw err(503, 'La conexión con Azure DevOps no está configurada en el servidor.', 'azure_disabled');
  const url = base() + '/' + encodeURIComponent(org()) + '/' + encodeURIComponent(proj) + urlPath;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 30000);
  let r;
  try {
    r = await fetch(url, {
      method, signal: ctl.signal, redirect: 'manual',
      headers: { Authorization: 'Basic ' + Buffer.from(':' + pat()).toString('base64'), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) { throw err(502, e.name === 'AbortError' ? 'Azure DevOps tardó demasiado en responder.' : 'No se pudo conectar con Azure DevOps.', 'azure_network'); }
  finally { clearTimeout(to); }
  if (r.status === 203 || (r.status >= 300 && r.status < 400) || r.status === 401) throw err(502, 'Azure rechazó la llave (PAT): no es válida o venció. Genera una nueva y actualízala en Render.', 'azure_auth');
  if (r.status === 403) throw err(502, forbiddenMsg || 'La llave (PAT) no tiene permiso para leer work items (Work Items → Read).', 'azure_forbidden');
  if (r.status === 404) throw err(502, 'No se encontró la organización o el proyecto de Azure. Revisa AZURE_DEVOPS_ORG y el nombre del proyecto.', 'azure_notfound');
  if (r.status === 429) throw err(502, 'Azure limitó las consultas; se reintenta más tarde.', 'azure_rate');
  const ct = String(r.headers.get('content-type') || '');
  let j = null; if (ct.includes('json')) { try { j = await r.json(); } catch (e) {} }
  if (!r.ok) throw err(502, 'Azure respondió con error' + (j && j.message ? ': ' + String(j.message).slice(0, 300) : ' (' + r.status + ').'), 'azure_error');
  if (!j) throw err(502, 'Azure respondió algo inesperado. Revisa AZURE_DEVOPS_ORG.', 'azure_unexpected');
  return j;
}

/* ---------- consulta ---------- */
const FIELDS = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority', 'System.CreatedDate', 'Microsoft.VSTS.Common.ActivatedDate',
  'Microsoft.VSTS.Common.ResolvedDate', 'Microsoft.VSTS.Common.ClosedDate', 'System.Parent', 'System.Tags', 'System.AreaPath', 'System.IterationPath'];

function buildWiql(cfg, proj) {
  const types = bugTypes().map(t => "'" + q(t) + "'").join(', ');
  if (cfg.padre) {
    return "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = " + cfg.padre +
      " AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' AND [Target].[System.WorkItemType] <> '' MODE (Recursive)";
  }
  const wh = ["[System.TeamProject] = '" + q(proj) + "'", '[System.WorkItemType] IN (' + types + ')'];
  if (cfg.area) wh.push("[System.AreaPath] UNDER '" + q(fullPath(proj, cfg.area)) + "'");
  if (cfg.iteracion) wh.push("[System.IterationPath] UNDER '" + q(fullPath(proj, cfg.iteracion)) + "'");
  if (cfg.tag) wh.push("[System.Tags] CONTAINS '" + q(cfg.tag) + "'");
  return 'SELECT [System.Id] FROM WorkItems WHERE ' + wh.join(' AND ') + ' ORDER BY [System.Id]';
}
async function fetchBatch(proj, ids, fields) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await call('POST', proj, '/_apis/wit/workitemsbatch?api-version=' + API, { ids: ids.slice(i, i + 200), fields, errorPolicy: 'Omit' });
    (r.value || []).forEach(w => { if (w && w.fields) out.push(w); });
  }
  return out;
}
const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };

async function fetchBugs(rawCfg) {
  const cfg = cleanCfg(rawCfg), proj = projectOf(cfg);
  const wiql = buildWiql(cfg, proj);
  const res = await call('POST', proj, '/_apis/wit/wiql?api-version=' + API + '&$top=' + (cfg.padre ? 20000 : MAX_BUGS + 1), { query: wiql });
  let ids;
  if (cfg.padre) {
    ids = Array.from(new Set((res.workItemRelations || []).map(x => x && x.target && x.target.id).filter(n => n && String(n) !== cfg.padre)));
  } else {
    ids = Array.from(new Set((res.workItems || []).map(x => x && x.id).filter(Boolean)));
  }
  let items = ids.length ? await fetchBatch(proj, ids, FIELDS) : [];
  /* En consulta por padre se filtra aquí: tipo bug, y área / iteración / etiqueta si se indicaron. */
  if (cfg.padre) {
    const types = bugTypes().map(t => t.toLowerCase()), tg = cfg.tag.toLowerCase();
    const ap = cfg.area ? fullPath(proj, cfg.area) : '', ip = cfg.iteracion ? fullPath(proj, cfg.iteracion) : '';
    items = items.filter(w => {
      const f = w.fields;
      if (!types.includes(String(f['System.WorkItemType'] || '').toLowerCase())) return false;
      if (ap && !under(f['System.AreaPath'], ap)) return false;
      if (ip && !under(f['System.IterationPath'], ip)) return false;
      if (tg && !String(f['System.Tags'] || '').split(';').map(s => s.trim().toLowerCase()).includes(tg)) return false;
      return true;
    });
  }
  items.sort((a, b) => Number(a.fields['System.Id']) - Number(b.fields['System.Id']));
  const truncated = items.length > MAX_BUGS;
  if (truncated) items = items.slice(0, MAX_BUGS);
  /* título del padre (la HU) para poder relacionar cada bug con su HU por código */
  const pids = Array.from(new Set(items.map(w => w.fields['System.Parent']).filter(Boolean)));
  const ptitle = {};
  if (pids.length) (await fetchBatch(proj, pids, ['System.Id', 'System.Title'])).forEach(w => { ptitle[w.fields['System.Id']] = String(w.fields['System.Title'] || ''); });
  const bugs = items.map(w => {
    const f = w.fields, pid = f['System.Parent'];
    return {
      id: String(f['System.Id']), t: String(f['System.Title'] || '').slice(0, 120),
      s: String(f['Microsoft.VSTS.Common.Severity'] || '').trim(), pr: f['Microsoft.VSTS.Common.Priority'] != null ? String(f['Microsoft.VSTS.Common.Priority']).trim() : '', e: String(f['System.State'] || '').trim(),
      c: iso(f['System.CreatedDate']), a: iso(f['Microsoft.VSTS.Common.ActivatedDate']), r: iso(f['Microsoft.VSTS.Common.ResolvedDate']), k: iso(f['Microsoft.VSTS.Common.ClosedDate']),
      h: null, p: ((pid ? pid + ' ' + (ptitle[pid] || '') : '') + ' ' + String(f['System.Tags'] || '')).trim().slice(0, 160)
    };
  });
  return { bugs, truncated, proyecto: proj, wiql, cfg, webBase: base() + '/' + encodeURIComponent(org()) + '/' + encodeURIComponent(proj) + '/_workitems/edit/' };
}

/* Vista previa para el botón "Probar consulta": no guarda nada. */
async function preview(rawCfg) {
  const r = await fetchBugs(rawCfg);
  return { total: r.bugs.length, truncated: r.truncated, sample: r.bugs.slice(0, 5).map(b => ({ id: b.id, t: b.t, s: b.s, e: b.e })), wiql: r.wiql, proyecto: r.proyecto };
}


/* ---------- Test Plans (avance de pruebas) ---------- */
const stripAcc = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normName = x => stripAcc(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const FORBID_TEST = 'La llave (PAT) no tiene permiso para leer Test Plans: agrega el permiso «Test Management → Read» a la llave en Azure DevOps.';

function cleanTestCfg(c) {
  c = c || {};
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const out = { proyecto: s(c.proyecto, 128), plan: s(c.plan, 200).replace(/^#/, '') };
  if (!out.plan) throw bad('Escribe el nombre (o el ID) del plan de pruebas, tal como aparece en Azure Test Plans.');
  if (out.proyecto && !/^[\p{L}\p{N} ._()&\-]{1,128}$/u.test(out.proyecto)) throw bad('El nombre del proyecto de Azure tiene caracteres no válidos.');
  return out;
}
function testProjectOf(cfg) {
  const p = cfg.proyecto || testProject();
  if (!p) throw bad('Falta el proyecto de Azure donde está el plan de pruebas (por ejemplo «Gestion Proyectos»).');
  return p;
}
async function pagedList(proj, path, what) {
  const out = []; const sep = path.includes('?') ? '&' : '?';
  for (let skip = 0, guard = 0; guard < 400; guard++) {
    const r = await call('GET', proj, path + sep + 'api-version=' + API + '&$top=200&$skip=' + skip, undefined, FORBID_TEST);
    const v = Array.isArray(r.value) ? r.value : [];
    if (!v.length) break;
    if (out.length && v[0] && out[0] && JSON.stringify(v[0]) === JSON.stringify(out[0])) break;   /* el servidor ignoró $skip: evita repetir la misma página */
    out.push(...v); skip += v.length;
  }
  return out;
}
async function findPlan(proj, ref) {
  if (/^\d{1,9}$/.test(ref)) {
    /* Un número puede ser el ID del plan o el comienzo de su nombre («036»): primero se busca como ID y, si no existe, como nombre. */
    try { return await call('GET', proj, '/_apis/test/plans/' + Number(ref) + '?api-version=' + API, undefined, FORBID_TEST); }
    catch (e) { if (!(e && e.code === 'azure_notfound')) throw e; }
  }
  const plans = await pagedList(proj, '/_apis/test/plans', 'planes');
  const want = normName(ref);
  let hit = plans.filter(x => normName(x.name) === want);
  if (!hit.length) hit = plans.filter(x => normName(x.name).includes(want) || (want.length > 3 && want.includes(normName(x.name))));
  if (hit.length === 1) return hit[0];
  const names = l => l.slice(0, 8).map(x => '«' + x.name + '»').join(', ');
  if (hit.length > 1) throw err(400, 'Hay varios planes que coinciden con «' + ref + '»: ' + names(hit) + '. Escribe el nombre completo o el ID.', 'azure_plan');
  const num = (ref.match(/\d+/) || [''])[0];
  const near = num ? plans.filter(x => String(x.name).includes(num)) : [];
  throw err(404, 'No se encontró el plan «' + ref + '» en el proyecto «' + proj + '».' + (plans.length ? ' Planes disponibles: ' + names(near.length ? near : plans) + (plans.length > 8 && !near.length ? '…' : '') + '.' : ' El proyecto no tiene planes de pruebas.'), 'azure_plan');
}
function outcomeKey(o) {
  switch (String(o || '').toLowerCase()) {
    case 'passed': return 'ok';
    case 'failed': return 'fail';
    case 'blocked': return 'block';
    case 'notapplicable': return 'na';
    case 'paused': return 'pause';
    default: return 'pend';      /* none, unspecified, notexecuted, inprogress, inconclusive… = sin ejecutar */
  }
}
const MAX_SUITES = 500, MAX_POINTS = 30000;
async function fetchTests(rawCfg) {
  const cfg = cleanTestCfg(rawCfg), proj = testProjectOf(cfg);
  const plan = await findPlan(proj, cfg.plan);
  const suites = new Map();
  if (plan.rootSuite && plan.rootSuite.id != null) suites.set(String(plan.rootSuite.id), true);
  (await pagedList(proj, '/_apis/test/Plans/' + plan.id + '/suites', 'suites')).forEach(x => { if (x && x.id != null) suites.set(String(x.id), true); });
  const ids = Array.from(suites.keys());
  if (ids.length > MAX_SUITES) throw err(400, 'El plan tiene ' + ids.length + ' suites (el máximo que se lee es ' + MAX_SUITES + ').', 'azure_plan');
  const counts = { ok: 0, fail: 0, block: 0, na: 0, pause: 0, pend: 0 }, outcomes = {};
  let total = 0, next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const sid = ids[next++];
      const pts = await pagedList(proj, '/_apis/test/Plans/' + plan.id + '/Suites/' + sid + '/points', 'puntos');
      pts.forEach(pt => {
        const o = String((pt && pt.outcome) || 'Unspecified');
        counts[outcomeKey(o)]++; outcomes[o] = (outcomes[o] || 0) + 1; total++;
      });
      if (total > MAX_POINTS) throw err(400, 'El plan tiene demasiados casos de prueba para leerlos (más de ' + MAX_POINTS + ').', 'azure_plan');
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { plan: { id: String(plan.id), name: String(plan.name || '') }, proyecto: proj, suites: ids.length, total, counts, outcomes, cfg,
    webUrl: base() + '/' + encodeURIComponent(org()) + '/' + encodeURIComponent(proj) + '/_testManagement/analytics/progressreport' };
}
async function previewTests(rawCfg) {
  const r = await fetchTests(rawCfg);
  return { plan: r.plan, proyecto: r.proyecto, suites: r.suites, total: r.total, counts: r.counts, outcomes: r.outcomes, webUrl: r.webUrl };
}

/* ---------- sincronización de un proyecto ---------- */
const inflight = new Map();
const fresh = (t, e) => t && !e && Date.now() - new Date(t).getTime() < 120000;
async function syncProject(id, who, opt) {
  opt = opt || {};
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const proj = await store.getDoc('projects', id);
    if (!proj) throw err(404, 'El proyecto no existe.', 'not_found');
    const hasBugs = !!proj.data.azureCfg, hasTests = !!proj.data.azureTest;
    if (!hasBugs && !hasTests) throw err(400, 'Este proyecto no tiene vínculo con Azure DevOps.', 'bad_request');
    const prev = await store.getDoc('azure_bugs', id);
    const pd = prev && prev.data;
    const bugsFresh = !hasBugs || (pd && fresh(pd.syncedAt, pd.error));
    const testsFresh = !hasTests || (pd && pd.tests && fresh(pd.tests.syncedAt, pd.testsError));
    if (!opt.force && pd && bugsFresh && testsFresh) return { total: (pd.bugs || []).length, syncedAt: pd.syncedAt || (pd.tests && pd.tests.syncedAt), skipped: true };
    const doc = Object.assign({ bugs: [], total: 0 }, pd || {});
    let bugErr = null, testErr = null, okAny = false;
    if (hasBugs) {
      try {
        const r = await fetchBugs(proj.data.azureCfg);
        Object.assign(doc, { bugs: r.bugs, total: r.bugs.length, truncated: r.truncated, proyecto: r.proyecto, cfg: r.cfg, webBase: r.webBase, syncedAt: new Date().toISOString(), error: null }); okAny = true;
      } catch (e) { bugErr = e; doc.error = (e && e.msg) || 'No se pudo consultar Azure DevOps.'; doc.errorAt = new Date().toISOString(); }
    }
    if (hasTests) {
      try {
        const t = await fetchTests(proj.data.azureTest), now = new Date().toISOString();
        const samePlan = doc.tests && doc.tests.plan && doc.tests.plan.id === t.plan.id;
        const hist = samePlan && Array.isArray(doc.testsHist) ? doc.testsHist : [], last = hist[hist.length - 1], c = t.counts;
        const snap = { at: now, total: t.total, na: c.na, ok: c.ok, fail: c.fail, block: c.block, pause: c.pause };
        if (!last || ['total', 'na', 'ok', 'fail', 'block', 'pause'].some(k => last[k] !== snap[k])) hist.push(snap);
        doc.testsHist = hist.slice(-100);
        doc.tests = Object.assign({}, t, { syncedAt: now }); doc.testsError = null; okAny = true;
      } catch (e) { testErr = e; doc.testsError = (e && e.msg) || 'No se pudo leer el plan de pruebas.'; doc.testsErrorAt = new Date().toISOString(); }
    }
    const saved = await store.setDoc('azure_bugs', id, doc, who || 'azure');
    if (opt.broadcast) opt.broadcast({ op: 'set', col: 'azure_bugs', id, data: saved.data, version: saved.version });
    const e0 = bugErr || testErr;
    if (e0 && !okAny) throw e0.status ? e0 : err(502, (e0 && e0.msg) || 'No se pudo consultar Azure DevOps.');
    return { total: doc.total, syncedAt: doc.syncedAt || (doc.tests && doc.tests.syncedAt), truncated: doc.truncated, tests: hasTests ? (testErr ? { error: doc.testsError } : { total: doc.tests.total }) : undefined, bugsError: bugErr ? doc.error : undefined };
  })();
  inflight.set(id, job);
  try { return await job; } finally { inflight.delete(id); }
}

/* ---------- sincronización automática ---------- */
const open = d => d && (d.azureCfg || d.azureTest) && d.status !== 'certificado' && !d.cerradoEn;
async function syncAllOpen(broadcast) {
  if (!enabled()) return;
  let rows; try { rows = await store.listDocs('projects'); } catch (e) { console.error('Azure: no se pudieron leer los proyectos', e.message); return; }
  for (const r of rows.filter(x => open(x.data))) {
    try { await syncProject(r.id, 'azure-auto', { broadcast }); }
    catch (e) { console.error('Azure: falló la sincronización de ' + r.id + ': ' + ((e && e.msg) || e)); }
    await new Promise(res => setTimeout(res, 1000));
  }
}
let timer = null;
function startScheduler(broadcast) {
  if (!enabled() || timer) return;
  const every = syncMinutes() * 60000;
  setTimeout(() => syncAllOpen(broadcast), 30000).unref();
  timer = setInterval(() => syncAllOpen(broadcast), every); timer.unref();
}

/* Límite de uso por usuario (probar / sincronizar): 20 por 5 minutos. */
const hits = new Map();
function rateOk(uid) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 300000);
  if (arr.length >= 20) { hits.set(uid, arr); return false; }
  arr.push(now); hits.set(uid, arr); return true;
}

module.exports = { enabled, org, defaultProject, testProject, cleanTestCfg, fetchTests, previewTests, findPlan, outcomeKey, syncMinutes, cleanCfg, buildWiql, fetchBugs, preview, syncProject, syncAllOpen, startScheduler, rateOk, bugTypes };
