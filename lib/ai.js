'use strict';
/* Proxy a la API de Gemini. La llave vive solo en el servidor (variable GEMINI_API_KEY). */
const KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const enabled = () => !!KEY;

const hits = new Map();   // usuario -> [timestamps]
function rateOk(uid) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 60000);
  if (arr.length >= 12) { hits.set(uid, arr); return false; }
  arr.push(now); hits.set(uid, arr); return true;
}

function parseJsonLoose(txt) {
  let t = String(txt || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch (e) {}
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) {} }
  return null;
}

async function askJson(prompt, images) {
  if (!KEY) throw { code: 'sampling_disabled' };
  const parts = [{ text: String(prompt).slice(0, 120000) }];
  (images || []).slice(0, 4).forEach(im => {
    if (im && im.data && /^image\/(png|jpe?g|webp|gif)$/i.test(im.mime || '')) parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  });
  const url = BASE + '/models/' + encodeURIComponent(MODEL) + ':generateContent';
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 90000);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
    });
  } catch (e) { throw { code: e.name === 'AbortError' ? 'timeout' : 'upstream' }; }
  finally { clearTimeout(to); }
  if (r.status === 429) throw { code: 'rate_limited' };
  if (r.status === 400 || r.status === 403 || r.status === 404) {
    let m = ''; try { m = (await r.json()).error.message; } catch (e) {}
    console.error('[gemini] ' + r.status + ' ' + m);
    throw { code: r.status === 400 ? 'bad_request' : 'bad_key' };
  }
  if (!r.ok) { console.error('[gemini] HTTP ' + r.status); throw { code: 'upstream' }; }
  const j = await r.json();
  const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
  const out = Array.isArray(txt) ? txt.map(p => p.text || '').join('') : '';
  if (!out.trim()) throw { code: 'empty_completion' };
  const data = parseJsonLoose(out);
  if (data == null) throw { code: 'invalid_json' };
  return data;
}

module.exports = { enabled, askJson, rateOk, MODEL };
