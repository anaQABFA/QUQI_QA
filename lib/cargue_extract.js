'use strict';
/* Cargue de proyectos en QA · extractores de Historias de Usuario (portados del Agente QA).
   Cada extractor recibe un Buffer y devuelve [{ origen_hu, titulo_hu, quiero, para, criterios[] }].
   - Excel (.xlsx): reglas exactas por columnas (igual que el agente).
   - Markdown / texto (.md, .markdown, .txt): reglas exactas por formato «HU n — título / Quiero / Para / Criterios».
   - PDF y PPTX: primero las reglas del Markdown sobre el texto; si no hay HU, se le pide a la IA (se inyecta como `ia`). */
const JSZip = require('jszip');

const SUPPORTED = ['.xlsx', '.md', '.markdown', '.txt', '.pdf', '.pptx'];
const PRIORITY = ['.xlsx', '.md', '.markdown', '.txt', '.pdf', '.pptx'];
const extOf = name => { const m = /\.[^.\\/]+$/.exec(String(name || '').toLowerCase()); return m ? m[0] : ''; };

/* ---------- Excel (.xlsx) ---------- */
const HOJAS_EXCLUIDAS = new Set(['Solicitud', 'Listados', 'Instructivo_General', 'Viabilidad económica', 'Estimaciones']);
const PATRON_HU = /^(HU|H\.U\.|Historia|US|User\s?Story)[\s\-_]*\d*/i;

const decodeXml = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const colIndex = ref => { const m = /^([A-Z]+)/i.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const textOf = xml => { let t = ''; String(xml).replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, x) => { t += decodeXml(x); return ''; }); return t; };

async function readXlsx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const read = async p => { const f = zip.file(p); return f ? f.async('string') : ''; };
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  ss.replace(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g, (_, x) => { shared.push(textOf(x)); return ''; });
  const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
  const relMap = {}; rels.replace(/<Relationship\b([^>]*)\/?>/g, (_, a) => { const id = /Id="([^"]*)"/.exec(a), t = /Target="([^"]*)"/.exec(a); if (id && t) relMap[id[1]] = t[1]; return ''; });
  const sheets = [];
  wb.replace(/<sheet\b([^>]*)\/?>/g, (_, a) => {
    const n = /name="([^"]*)"/.exec(a), r = /r:id="([^"]*)"/.exec(a); if (!n || !r) return '';
    let tgt = relMap[r[1]] || ''; tgt = tgt.replace(/^\//, ''); if (!/^xl\//.test(tgt)) tgt = 'xl/' + tgt;
    sheets.push({ name: decodeXml(n[1]), path: tgt }); return '';
  });
  const out = [];
  for (const sh of sheets) {
    const xml = await read(sh.path), rows = [];
    xml.replace(/<row\b[^>]*?(?:\sr="(\d+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g, (_, rn, body) => {
      const ri = (rn ? +rn : rows.length + 1) - 1, row = rows[ri] = rows[ri] || [];
      String(body || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attrs, inner) => {
        const r = /\sr="([^"]*)"/.exec(' ' + attrs), t = /\st="([^"]*)"/.exec(' ' + attrs), ci = r ? colIndex(r[1]) : row.length; if (ci < 0) return '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner || ''); let val = null;
        if (t && t[1] === 'inlineStr') val = textOf(inner || '');
        else if (v) { const raw = decodeXml(v[1]); val = t && t[1] === 's' ? (shared[+raw] != null ? shared[+raw] : '') : raw; }
        if (val !== null && String(val).trim() !== '') row[ci] = String(val);
        return '';
      });
      return '';
    });
    out.push({ name: sh.name, rows });
  }
  return out;
}

async function extraerExcel(buf) {
  const historias = [];
  for (const sh of await readXlsx(buf)) {
    if (HOJAS_EXCLUIDAS.has(sh.name)) continue;
    const rows = sh.rows, cell = (i, c) => { const v = (rows[i] || [])[c]; return v == null ? '' : String(v).trim(); };
    const n = rows.length;
    let i = 0;
    while (i < n) {
      const b = cell(i, 1);
      if (b && PATRON_HU.test(b)) {
        const criterios = []; let j = i + 1;
        while (j < n) { if (PATRON_HU.test(cell(j, 1))) break; const c = cell(j, 3); if (c) criterios.push(c); j++; }
        historias.push({ origen_hu: sh.name + '-' + b, titulo_hu: cell(i, 3) || 'Sin Título', quiero: cell(i, 5), para: cell(i, 6), criterios });
        i = j - 1;
      }
      i++;
    }
  }
  return historias;
}

/* ---------- Markdown / texto ---------- */
const RE_HU = /^[ \t]*#{0,6}[ \t]*\**[ \t]*(?:HU|H\.U\.|Historia(?: de usuario)?|US|User Story)[ \t\-#]*(\d+[A-Za-z]?)[ \t]*\**[ \t]*[—–:\-.][ \t]*\**[ \t]*(.+?)[ \t]*\**[ \t]*$/gim;
const RE_CORTE = /^[ \t]*#{1,2}[ \t]+\S/gm;
const RE_ITEM = /^[ \t]*(?:\d+[.)]|[-*•])[ \t]+(.+?)[ \t]*$/gm;
const limpiar = t => String(t).replace(/\(cid:\d+\)/g, '').replace(/\r\n?/g, '\n');
const flat = s => String(s).replace(/\s+/g, ' ').trim();
const trimMark = s => s.replace(/^[*_ ]+|[*_ ]+$/g, '').trim();
function campo(bloque, nombre) {
  const re = new RegExp('(?:^|\\n)[ \\t]*[*_]*' + nombre + '[*_]*[ \\t]*:?[ \\t]*[*_]*[ \\t]*([\\s\\S]+?)(?=\\n[ \\t]*[*_]*(?:yo como|quiero|para|criterios)|$)', 'i');
  const m = re.exec(bloque); return m ? trimMark(flat(m[1])) : '';
}
function extraerDeTexto(texto) {
  texto = limpiar(texto);
  const heads = []; let m; RE_HU.lastIndex = 0;
  while ((m = RE_HU.exec(texto))) heads.push({ idx: m.index, end: m.index + m[0].length, num: m[1], titulo: m[2] });
  const out = [];
  heads.forEach((h, i) => {
    let fin = i + 1 < heads.length ? heads[i + 1].idx : texto.length;
    RE_CORTE.lastIndex = h.end; const c = RE_CORTE.exec(texto); if (c && c.index < fin) fin = c.index;
    const bloque = texto.slice(h.end, fin);
    const ic = /criterios?\s+de\s+aceptaci[oó]n/i.exec(bloque);
    const parteHu = ic ? bloque.slice(0, ic.index) : bloque, parteCrit = ic ? bloque.slice(ic.index + ic[0].length) : '';
    const quiero = campo(parteHu, 'quiero'), para = campo(parteHu, 'para');
    const criterios = []; RE_ITEM.lastIndex = 0; let k; while ((k = RE_ITEM.exec(parteCrit))) criterios.push(flat(k[1]));
    if (!(quiero || criterios.length)) return;   /* un «HU n» suelto (índice, referencia) no es una HU completa */
    out.push({ origen_hu: 'HU ' + h.num, titulo_hu: trimMark(h.titulo), quiero, para, criterios });
  });
  return out;
}

/* ---------- PDF y PPTX (texto → reglas → IA) ---------- */
const EXTRACCION_PROMPT = texto => `
Eres un asistente que extrae Historias de Usuario (HU) de un documento de requerimientos.

A continuación tienes el texto completo de un documento de requerimientos. Identifica cada
Historia de Usuario que encuentres (pueden estar etiquetadas como "HU", "Historia de Usuario",
"US", "User Story", con o sin número).

Para cada una, extrae:
- origen_hu: un identificador corto (ej. "HU-1", o el texto que usa el documento)
- titulo_hu: el título/nombre de la historia
- quiero: el texto de "Yo quiero..." o equivalente
- para: el texto de "Para..." o equivalente
- criterios: lista de criterios de aceptación (como strings)

Devuelve ÚNICAMENTE un arreglo JSON puro, sin markdown, con este formato:
[
  {"origen_hu": "...", "titulo_hu": "...", "quiero": "...", "para": "...", "criterios": ["..."]}
]

Si no encuentras una HU claramente, no la inventes.

TEXTO DEL DOCUMENTO:
${String(texto).slice(0, 60000)}
`;

async function textoPdf(buf) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');   /* la ruta directa evita el modo de depuración del index.js */
  /* pdf-parse (pdf.js antiguo) falla de forma esporádica con PDF válidos («bad XRef entry», «Invalid number»):
     se reintenta con una copia nueva del archivo antes de rendirse. */
  let ultimo = null;
  for (let i = 0; i < 4; i++) {
    try { const r = await pdfParse(Buffer.from(buf)); return r.text || ''; } catch (e) { ultimo = e; }
  }
  throw ultimo;
}
async function textoPptx(buf) {
  const zip = await JSZip.loadAsync(buf), nameNum = n => +(/(\d+)\.xml$/.exec(n) || [0, 0])[1];
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => nameNum(a) - nameNum(b));
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i]).async('string'), lines = ['--- Diapositiva ' + (i + 1) + ' ---'];
    xml.replace(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g, (_, p) => { let t = ''; p.replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (__, x) => { t += decodeXml(x); return ''; }); if (t.trim()) lines.push(t); return ''; });
    const notes = zip.file('ppt/notesSlides/notesSlide' + nameNum(slides[i]) + '.xml');
    if (notes) { let t = ''; (await notes.async('string')).replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (_, x) => { t += decodeXml(x) + ' '; return ''; }); if (t.trim()) lines.push('Notas: ' + t.trim()); }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
const sanear = arr => (Array.isArray(arr) ? arr : []).filter(h => h && typeof h === 'object').map(h => ({
  origen_hu: flat(h.origen_hu || ''), titulo_hu: flat(h.titulo_hu || 'Sin Título') || 'Sin Título', quiero: flat(h.quiero || ''), para: flat(h.para || ''),
  criterios: (Array.isArray(h.criterios) ? h.criterios : []).map(c => flat(c)).filter(Boolean)
}));
async function conIA(texto, ia, log) {
  if (!ia) { log && log('   ⚠️ El documento no trae HU con formato reconocible y la IA no está configurada.'); return []; }
  try { const r = await ia(EXTRACCION_PROMPT(texto)); return sanear(Array.isArray(r) ? r : (r && r.historias)); }
  catch (e) { log && log('   ⚠️ No se pudieron extraer HU con la IA: ' + (e && (e.msg || e.code || e.message) || e)); return []; }
}

/* ---------- despachador ---------- */
async function extraerHistorias(nombre, buf, opts) {
  opts = opts || {}; const ext = extOf(nombre), log = opts.log;
  if (ext === '.xlsx') return extraerExcel(buf);
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') return extraerDeTexto(buf.toString('utf8').replace(/^﻿/, ''));
  if (ext === '.pdf' || ext === '.pptx') {
    const texto = ext === '.pdf' ? await textoPdf(buf) : await textoPptx(buf);
    if (!texto.trim()) { log && log('   ⚠️ El ' + ext.slice(1).toUpperCase() + ' no tiene texto extraíble' + (ext === '.pdf' ? ' (¿es un escaneo/imagen? haría falta OCR).' : '.')); return []; }
    const reglas = extraerDeTexto(texto); if (reglas.length) return reglas;
    return conIA(limpiar(texto), opts.ia, log);
  }
  if (ext === '.xls') throw new Error('El formato .xls (Excel antiguo) no está soportado: guárdalo como .xlsx.');
  throw new Error('Tipo de archivo no soportado: ' + (ext || nombre));
}

module.exports = { SUPPORTED, PRIORITY, extOf, extraerHistorias, extraerDeTexto, extraerExcel, textoPdf, textoPptx, sanear };
