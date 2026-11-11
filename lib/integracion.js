'use strict';
/* Integración de solo lectura con Fluxor (y otros), protegida con llave.
   Todo vive aquí para que server.js solo necesite UNA línea:
     require('./lib/integracion')(app, wrap);
   Esa línea va justo después del middleware app.use('/api/integracion', ...) que valida la llave.
   Se registra antes que las rutas viejas de server.js, así que estas ganan aunque alguien
   vuelva a pegar una versión antigua de esas rutas. */
const db = require('./db');
const metrics = require('./metrics');
const novedades = require('./novedades');
const { dayCO } = require('./azure');

const normQ = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/* Novedades del seguimiento de un proyecto (o de todos), con su id. */
async function segEntries(projectId) {
  const r = projectId
    ? await db.q("SELECT id, data FROM docs WHERE col='seguimiento' AND data->>'projectId'=$1", [projectId])
    : await db.q("SELECT id, data FROM docs WHERE col='seguimiento'");
  return r.rows.map(x => Object.assign({}, x.data, { id: x.id }));
}

async function integracionRows() {
  const pr = (await db.q("SELECT id, data, updated_at FROM docs WHERE col='projects'")).rows;
  const az = new Map((await db.q("SELECT id, data FROM docs WHERE col='azure_bugs'")).rows.map(r => [r.id, r.data]));
  const segs = new Map();
  (await segEntries()).forEach(e => { const k = e.projectId; if (!segs.has(k)) segs.set(k, []); segs.get(k).push(e); });
  const now = new Date(), today = dayCO(now.toISOString());
  return pr.map(r => {
    const p = r.data || {}, a = az.get(r.id), b = novedades.bugsDe(p, a);
    return Object.assign(metrics.summarize(r, a, now), {
      tiempoPruebas: novedades.tiempoPruebas(p, segs.get(r.id) || [], today),
      bugs: { vinculado: b.vinculado, total: b.total, abiertos: b.abiertos },
      planPruebasUrl: novedades.planPruebasUrl(p, a),
    });
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

module.exports = function registrar(app, wrap) {
  app.get('/api/integracion/proyectos', wrap(async (req, res) => {
    let list = await integracionRows();
    const est = normQ(req.query.estado);
    if (est === 'abiertos') list = list.filter(p => !p.cerrado);
    else if (est === 'cerrados') list = list.filter(p => p.cerrado);
    else if (est && est !== 'todos') list = list.filter(p => p.estado === est);
    const nom = normQ(req.query.nombre);
    if (nom) list = list.filter(p => normQ(p.nombre).includes(nom));
    res.json({ generadoEn: new Date().toISOString(), total: list.length, proyectos: list });
  }));

  /* Detalle: bugs de Azure vinculados, seguimiento (novedades) y cambios de alcance. Va antes de /:id. */
  app.get('/api/integracion/proyectos/:id/detalle', wrap(async (req, res) => {
    const row = (await db.q("SELECT id, data, updated_at FROM docs WHERE col='projects' AND id=$1", [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'No existe un proyecto con ese id.' });
    const azr = (await db.q("SELECT data FROM docs WHERE col='azure_bugs' AND id=$1", [req.params.id])).rows[0];
    const p = row.data || {}, az = azr && azr.data, entries = await segEntries(req.params.id);
    const today = dayCO(new Date().toISOString()), s = novedades.seguimientoDe(entries, today);
    res.json({
      generadoEn: new Date().toISOString(), id: row.id, nombre: p.name || '',
      bugs: novedades.bugsDe(p, az),
      seguimiento: s.seguimiento,
      alcance: s.alcance,
      planPruebasUrl: novedades.planPruebasUrl(p, az),
      tiempoPruebas: novedades.tiempoPruebas(p, entries, today),
    });
  }));

  app.get('/api/integracion/proyectos/:id', wrap(async (req, res) => {
    const p = (await integracionRows()).find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'No existe un proyecto con ese id.' });
    res.json(Object.assign({ generadoEn: new Date().toISOString() }, p));
  }));
};
