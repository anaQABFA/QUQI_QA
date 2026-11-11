'use strict';
/* Cargue de proyectos en QA · Google Drive de solo lectura (API REST con el refresh token de una cuenta autorizada; sin interfaz de login).
   Variables: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN, DRIVE_ROOT_FOLDER_ID. */
const X = require('./cargue_extract');

const FOLDER = 'application/vnd.google-apps.folder', SHORTCUT = 'application/vnd.google-apps.shortcut';
const API = () => process.env.GOOGLE_DRIVE_BASE_URL || 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const env = k => String(process.env[k] || '').trim();
const configured = () => !!(env('GOOGLE_OAUTH_CLIENT_ID') && env('GOOGLE_OAUTH_CLIENT_SECRET') && env('GOOGLE_OAUTH_REFRESH_TOKEN'));
const rootFolderId = () => env('DRIVE_ROOT_FOLDER_ID');
const ID_OK = /^[A-Za-z0-9_-]{10,100}$/;

let tok = { value: '', exp: 0 };
async function timed(url, opts) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 60000);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Google Drive tardó demasiado en responder.' : 'No se pudo conectar con Google Drive.'); }
  finally { clearTimeout(to); }
}
async function accessToken() {
  if (!configured()) throw new Error('Faltan variables de Google Drive (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN).');
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const r = await timed(TOKEN_URL(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_OAUTH_CLIENT_ID'), client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET'), refresh_token: env('GOOGLE_OAUTH_REFRESH_TOKEN'), grant_type: 'refresh_token' }) });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (!r.ok || !j || !j.access_token) {
    const e = j && (j.error_description || j.error) || ('HTTP ' + r.status);
    throw new Error('Google rechazó las credenciales de Drive (' + String(e).slice(0, 120) + '). Si el refresh token venció o se revocó, vuelve a correr setup_google_auth.py y actualiza GOOGLE_OAUTH_REFRESH_TOKEN en Render.');
  }
  tok = { value: j.access_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
  return tok.value;
}
async function get(path, params, raw) {
  const t = await accessToken();
  const r = await timed(API() + path + '?' + new URLSearchParams(params), { headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 401) tok = { value: '', exp: 0 };
  if (r.status === 404) throw new Error('Drive: no se encontró la carpeta o archivo (revisa el ID y que la cuenta autorizada tenga acceso).');
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (_) {} throw new Error('Drive respondió ' + r.status + (m ? ': ' + String(m).slice(0, 140) : '.')); }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
const resolveItem = f => {
  if (f.mimeType === SHORTCUT) { const d = f.shortcutDetails || {}; return { id: d.targetId || f.id, name: f.name, mimeType: d.targetMimeType || f.mimeType }; }
  return { id: f.id, name: f.name, mimeType: f.mimeType };
};
/* Archivos y carpetas directos de una carpeta (resuelve accesos directos). */
async function listChildren(folderId, onlyFolders) {
  if (!ID_OK.test(String(folderId || ''))) throw new Error('ID de carpeta de Drive inválido.');
  const out = []; let page = '';
  do {
    const p = { q: "'" + folderId + "' in parents and trashed = false", spaces: 'drive', fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails)', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', pageSize: '200' };
    if (page) p.pageToken = page;
    const j = await get('/files', p); (j.files || []).forEach(f => out.push(resolveItem(f))); page = j.nextPageToken || '';
  } while (page);
  const l = onlyFolders ? out.filter(f => f.mimeType === FOLDER) : out;
  return l.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}
/* Archivos de requerimientos candidatos de un proyecto, por orden de preferencia: primero en una subcarpeta «requerimiento…», luego en la carpeta del proyecto. */
async function findRequirementFiles(projectFolderId) {
  const hijos = await listChildren(projectFolderId);
  const reqs = hijos.filter(c => c.mimeType === FOLDER && /requerimiento/i.test(c.name));
  const lugares = reqs.length ? [reqs[0].id, projectFolderId] : [projectFolderId];
  for (const id of lugares) {
    const lista = id === projectFolderId ? hijos : await listChildren(id);
    const cand = lista.filter(f => f.mimeType !== FOLDER && X.SUPPORTED.includes(X.extOf(f.name)));
    if (!cand.length) continue;
    const ord = []; X.PRIORITY.forEach(e => cand.filter(c => X.extOf(c.name) === e).forEach(c => ord.push(c)));
    return ord;
  }
  return [];
}
async function download(fileId) {
  if (!ID_OK.test(String(fileId || ''))) throw new Error('ID de archivo de Drive inválido.');
  return get('/files/' + encodeURIComponent(fileId), { alt: 'media', supportsAllDrives: 'true' }, true);
}
const resetToken = () => { tok = { value: '', exp: 0 }; };
module.exports = { configured, rootFolderId, listChildren, findRequirementFiles, download, resetToken };
