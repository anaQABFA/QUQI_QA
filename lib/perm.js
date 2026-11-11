'use strict';
/* Roles y permisos de QUQI_QA. Todo se valida aquí, en el servidor; la interfaz solo es una comodidad.
   admin     : todo (único que carga proyectos, borra proyectos y administra usuarios).
   pmo       : ve todo, sin editar (incluida la bitácora).
   pmo_lider : ve solo los proyectos que tiene asignados, sin editar y sin bitácora.
   analista  : analista QA: ve y edita solo los proyectos que tiene asignados (no crea ni borra proyectos); bitácora propia; ambientes.
   po        : ve el % de entrega y el % de avance de QA de sus proyectos; deja comentarios; reporta fallas de ambientes.
   ambientes : solo gestiona los ambientes de QA (marca si fallan o no, ocasional o intermitente, y ve el histórico); no ve proyectos ni nada más. */
const ROLES = ['admin', 'pmo', 'pmo_lider', 'analista', 'po', 'ambientes'];
const ROLE_LABEL = { admin: 'Administrador', pmo: 'PMO', pmo_lider: 'PMO líder', analista: 'Analista QA', po: 'PO', ambientes: 'Ambientes' };
const ASSIGN_KEYS = { pmoLider: 'pmo_lider', analista: 'analista', po: 'po' };   // campo de asignación → rol de usuario
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Caché de asignaciones: id de proyecto → asignacion {pmoLider:{id,name}, analista:{id,name}, po:{id,name}} */
const PA = new Map();
function setPA(id, data) { if (data && isObj(data.asignacion)) PA.set(id, data.asignacion); else PA.delete(id); }
function loadPA(rows) { PA.clear(); (rows || []).forEach(r => setPA(r.id, r.data)); }
const assignedTo = (asig, role, uid) => {
  const k = role === 'pmo_lider' ? 'pmoLider' : role;
  return !!(asig && asig[k] && Number(asig[k].id) === Number(uid));
};
const projAssigned = (role, uid, pid) => assignedTo(PA.get(pid), role, uid);

/* Un analista que ayudó en un proyecto que no tiene asignado ve, de ese proyecto, solo su propia actividad: nombre, casos que ejecutó y casos que creó. */
function helpView(uid, d) {
  if (!d) return null;
  const k = String(uid), pick = m => { const o = {}; Object.keys(m || {}).forEach(day => { if (m[day] && m[day][k]) o[day] = { [k]: m[day][k] }; }); return o; };
  const ex = pick(d.execDays), cr = pick(d.createDays);
  if (!Object.keys(ex).length && !Object.keys(cr).length) return null;
  return { ayuda: true, pname: d.pname || '', execDays: ex, createDays: cr };
}

/* ¿Qué ve este usuario de un documento? Devuelve el documento (posiblemente recortado) o null. */
function readDoc(ctx, col, id, data) {
  const role = ctx.role;
  if (col === 'azure_bugs' && data && (data.ptState || data.ctMeta)) { data = Object.assign({}, data); delete data.ptState; delete data.ctMeta; }   /* estado interno del servidor, no sale al navegador */
  if (role === 'admin') return data;
  const all = role === 'pmo';
  const mine = pid => all || projAssigned(role, ctx.uid, pid);
  switch (col) {
    case 'projects': return mine(id) ? data : null;
    case 'seguimiento': return role === 'po' ? null : (mine(data && data.projectId) ? data : null);
    case 'comentarios': return mine(data && data.projectId) ? data : null;
    case 'azure_bugs':
      if (!mine(id)) return role === 'analista' ? helpView(ctx.uid, data) : null;
      if (role === 'po') return { tests: data.tests || null, testsHist: data.testsHist || [], testsError: data.testsError || null, syncedAt: data.syncedAt || null, bugs: [] };   /* el PO no ve el detalle de bugs */
      return data;
    case 'bitacora': return all ? data : (role === 'analista' && ctx.analystDocId && String(id).startsWith(ctx.analystDocId + '_') ? data : null);
    case 'analistas': return all ? data : (role === 'analista' && id === ctx.analystDocId ? data : null);
    case 'archivos': case 'archivos_data': return mine(data && data.projectId) ? data : null;   /* los archivos del proyecto los puede descargar cualquier perfil que vea el proyecto */
    case 'config': case 'amb_hojas': case 'amb_hist': return data;
    default: return null;
  }
}

/* ¿Puede escribir? op: create | update | delete. `cur` = documento actual (o null), `nxt` = documento nuevo (create/update).
   Devuelve null si puede, o un texto con el motivo. */
function writeProblem(ctx, col, id, op, cur, nxt) {
  const role = ctx.role;
  if (col === 'azure_bugs') return 'Ese dato lo escribe solo el servidor.';
  if (role === 'admin') return null;
  const RO = 'Tu perfil (' + ROLE_LABEL[role] + ') es de solo lectura en esta sección.';
  if (role === 'pmo' || role === 'pmo_lider') return RO;
  if (role === 'analista') {
    switch (col) {
      case 'projects':
        if (op === 'create') return 'Los proyectos nuevos los carga el administrador.';
        if (op === 'delete') return 'Solo el administrador puede borrar proyectos.';
        return cur && projAssigned(role, ctx.uid, id) ? null : 'Ese proyecto no está asignado a ti.';
      case 'seguimiento': {
        const pid = (cur && cur.projectId) || (nxt && nxt.projectId);
        if (op === 'update' && nxt && cur && nxt.projectId !== cur.projectId) return 'No se puede mover una anotación a otro proyecto.';
        return projAssigned(role, ctx.uid, pid) ? null : 'Ese proyecto no está asignado a ti.';
      }
      case 'bitacora': return ctx.analystDocId && String(id).startsWith(ctx.analystDocId + '_') ? null : 'Solo puedes editar tu propia bitácora.';
      case 'analistas': return 'Los analistas de la bitácora los administra el administrador.';
      case 'comentarios': return commentProblem(ctx, op, cur, nxt);
      case 'archivos': case 'archivos_data': {
        const pid = (cur && cur.projectId) || (nxt && nxt.projectId);
        if (op === 'update' && cur && nxt && nxt.projectId !== cur.projectId) return 'No se puede mover un archivo a otro proyecto.';
        return projAssigned(role, ctx.uid, pid) ? null : 'Ese proyecto no está asignado a ti.';
      }
      case 'amb_hist': return op === 'delete' ? 'Solo el administrador puede borrar registros del histórico.' : null;
      case 'config': case 'amb_hojas': return null;
      default: return RO;
    }
  }
  if (role === 'ambientes') {
    switch (col) {
      case 'amb_hist': return op === 'delete' ? 'Solo el administrador puede borrar registros del histórico.' : null;
      case 'amb_hojas': return op === 'update' && onlyRowState(cur, nxt) ? null : 'El perfil Ambientes solo cambia el estado de una fila.';
      default: return RO;
    }
  }
  if (role === 'po') {
    switch (col) {
      case 'comentarios': return commentProblem(ctx, op, cur, nxt);
      case 'amb_hist': return op === 'delete' ? 'Solo el administrador puede borrar registros del histórico.' : null;
      case 'amb_hojas': return op === 'update' && onlyRowState(cur, nxt) ? null : 'El PO solo puede cambiar el estado de una fila de Ambientes.';
      default: return RO;
    }
  }
  return 'Sin permiso.';
}
/* El PO solo puede tocar, en las filas de una hoja de ambientes, los campos de estado (est, ult, hist, aviso). */
const ROW_STATE = new Set(['est', 'ult', 'hist', 'aviso']);
function onlyRowState(cur, nxt) {
  if (!isObj(cur) || !isObj(nxt)) return false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keys = new Set([...Object.keys(cur), ...Object.keys(nxt)]);
  for (const k of keys) {
    if (k === 'rows') continue;
    if (!same(cur[k], nxt[k])) return false;
  }
  const cr = isObj(cur.rows) ? cur.rows : {}, nr = isObj(nxt.rows) ? nxt.rows : {};
  const rk = new Set([...Object.keys(cr), ...Object.keys(nr)]);
  for (const r of rk) {
    if (!isObj(cr[r]) || !isObj(nr[r])) return false;      // no se crean ni se borran filas
    const fk = new Set([...Object.keys(cr[r]), ...Object.keys(nr[r])]);
    for (const f of fk) if (!ROW_STATE.has(f) && !same(cr[r][f], nr[r][f])) return false;
  }
  return true;
}
function commentProblem(ctx, op, cur, nxt) {
  const pid = (cur && cur.projectId) || (nxt && nxt.projectId);
  if (!projAssigned(ctx.role, ctx.uid, pid)) return 'Ese proyecto no está asignado a ti.';
  if (op !== 'create' && cur && Number(cur.autorId) !== Number(ctx.uid)) return 'Solo puedes cambiar o borrar tus propios comentarios.';
  return null;
}

module.exports = { ROLES, ROLE_LABEL, ASSIGN_KEYS, PA, setPA, loadPA, assignedTo, projAssigned, readDoc, writeProblem, isObj };
