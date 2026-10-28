/* Capa de conexión: le da al tablero la misma interfaz que tenía dentro de Claude
   (db / sample / downloads), pero apoyada en el servidor propio. */
(function(){
  'use strict';
  const clone = v => (typeof structuredClone === 'function') ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  function goLogin(){ if(location.pathname !== '/login.html') location.href = '/login.html'; }

  async function api(method, url, body){
    let r;
    try{
      r = await fetch(url, { method, credentials:'same-origin', headers: body!==undefined ? {'Content-Type':'application/json'} : undefined, body: body!==undefined ? JSON.stringify(body) : undefined });
    }catch(e){ throw { code:'network' }; }
    if(r.status === 401){ goLogin(); throw { code:'unauthorized' }; }
    let j = null; try{ j = await r.json(); }catch(e){}
    if(!r.ok){ throw Object.assign({ code: (j && j.code) || (r.status===413 ? 'quota_exceeded' : 'write_failed'), status:r.status, message: j && j.error }, {}); }
    return j;
  }

  /* ---------- base de datos ---------- */
  const cache = {};   // col -> { map:Map(id -> {data,version}), ready:Promise|null, subs:Set, timer }
  function colState(col){ return cache[col] || (cache[col] = { map:new Map(), ready:null, subs:new Set(), timer:null, loaded:false }); }
  function load(col){
    const st = colState(col);
    st.ready = api('GET', '/api/docs/' + col).then(rows => {
      const seen = new Set();
      rows.forEach(r => { seen.add(r.id); const cur = st.map.get(r.id); if(!cur || cur.version <= r.version) st.map.set(r.id, { data:r.data, version:r.version }); });
      Array.from(st.map.keys()).forEach(k => { if(!seen.has(k)) st.map.delete(k); });
      st.loaded = true; scheduleEmit(col);
    });
    return st.ready;
  }
  function ensure(col){ const st = colState(col); return st.ready || load(col); }
  function applyDoc(col, id, data, version){
    const st = colState(col), cur = st.map.get(id);
    if(cur && version != null && cur.version > version) return;
    st.map.set(id, { data, version: version || (cur ? cur.version : 0) }); scheduleEmit(col);
  }
  function removeDoc(col, id){ const st = colState(col); if(st.map.delete(id)) scheduleEmit(col); }
  function scheduleEmit(col){
    const st = colState(col); if(st.timer || !st.loaded) return;
    st.timer = setTimeout(() => { st.timer = null; st.subs.forEach(s => emit(st, s)); }, 30);
  }
  function emit(st, sub){
    let list = Array.from(st.map, ([id, e]) => ({ id, e }));
    if(sub.order){
      const f = sub.order.field, dir = sub.order.dir === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        const x = a.e.data[f], y = b.e.data[f];
        if(x == null && y == null) return 0; if(x == null) return 1; if(y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    if(sub.lim) list = list.slice(0, sub.lim);
    const snap = { docs: list.map(x => ({ id:x.id, data: () => clone(x.e.data) })) };
    try{ sub.cb(snap); }catch(e){ console.error(e); }
  }
  function makeQuery(col, order, lim){
    return {
      orderBy(field, dir){ return makeQuery(col, { field, dir: dir || 'asc' }, lim); },
      limit(n){ return makeQuery(col, order, n); },
      onSnapshot(cb, errCb){
        const st = colState(col), sub = { cb, order, lim }; st.subs.add(sub);
        ensure(col).then(() => { if(st.loaded) emit(st, sub); }).catch(e => { if(errCb) errCb(e); });
        return () => st.subs.delete(sub);
      },
      async add(data){
        const r = await api('POST', '/api/docs/' + col, data);
        applyDoc(col, r.id, clone(data), r.version); return { id: r.id };
      },
      doc(id){
        return {
          id,
          async set(data){ const r = await api('PUT', '/api/docs/' + col + '/' + encodeURIComponent(id), data); applyDoc(col, id, clone(data), r.version); },
          async update(patch){ const r = await api('PATCH', '/api/docs/' + col + '/' + encodeURIComponent(id), patch); applyDoc(col, id, r.data, r.version); },
          async delete(){ await api('DELETE', '/api/docs/' + col + '/' + encodeURIComponent(id)); removeDoc(col, id); }
        };
      }
    };
  }
  const dbNS = { collection: col => makeQuery(col, null, null) };

  /* tiempo real */
  function resyncAll(){ Object.keys(cache).forEach(c => { if(cache[c].ready) load(c).catch(() => {}); }); }
  let es = null, esDown = false;
  function startStream(){
    if(es || !window.EventSource) return;
    es = new EventSource('/api/stream');
    es.onmessage = ev => {
      let m; try{ m = JSON.parse(ev.data); }catch(e){ return; }
      if(m.op === 'resync') return resyncAll();
      const st = cache[m.col]; if(!st || !st.loaded) return;
      if(m.op === 'set') applyDoc(m.col, m.id, m.data, m.version);
      else if(m.op === 'del') removeDoc(m.col, m.id);
    };
    es.onopen = () => { if(esDown){ esDown = false; resyncAll(); } };
    es.onerror = () => { esDown = true; fetch('/api/me', { credentials:'same-origin' }).then(r => { if(r.status === 401) goLogin(); }).catch(() => {}); };
  }
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && es) resyncAll(); });

  /* ---------- IA (Gemini en el servidor) ---------- */
  function blobToB64(b){ return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(b); }); }
  const sampleNS = {
    async limits(){ return { images: { maxCount: 4 } }; },
    async json(prompt, opts){
      const imgs = [];
      for(const b of ((opts && opts.images) || [])){ imgs.push({ mime: b.type || 'image/jpeg', data: await blobToB64(b) }); }
      let r;
      try{ r = await api('POST', '/api/ai', { prompt, images: imgs }); }
      catch(e){ throw { code: e.code === 'network' ? 'upstream' : (e.code || 'upstream') }; }
      return r.data;
    }
  };

  /* ---------- descargas ---------- */
  const MIME = { xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv:'text/csv;charset=utf-8', pdf:'application/pdf', json:'application/json' };
  const dlNS = {
    async save(f){
      const ext = String(f.filename).split('.').pop().toLowerCase();
      const blob = new Blob([f.data], { type: MIME[ext] || 'application/octet-stream' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
  };

  /* ---------- Azure DevOps (solo lectura; la llave vive en el servidor) ---------- */
  const azureNS = {
    test: cfg => api('POST', '/api/azure/test', cfg || {}),
    testPlan: cfg => api('POST', '/api/azure/test-plan', cfg || {}),
    sync: (id, force) => api('POST', '/api/azure/sync/' + encodeURIComponent(id), { force: !!force })
  };

  /* ---------- sesión / usuario ---------- */
  const meP = api('GET', '/api/me').then(me => {
    window.__me = me;
    try{ localStorage.setItem('qacert_who', me.user.name); }catch(e){}
    return me;
  });
  function decorate(me){
    const who = document.getElementById('whoInput'); if(!who) return;
    who.value = me.user.name; who.readOnly = true; who.title = 'Sesión iniciada como ' + me.user.username;
    const box = who.parentNode, bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;align-items:center;font-size:12.5px;flex-wrap:wrap;justify-content:flex-end;';
    const link = (t, h, fn) => { const a = document.createElement('a'); a.textContent = t; a.href = h || '#'; a.style.cssText = 'color:var(--accent-strong);text-decoration:none;font-weight:600;'; if(fn) a.addEventListener('click', e => { e.preventDefault(); fn(); }); return a; };
    if(me.user.role === 'admin') bar.appendChild(link('Administración', '/admin.html'));
    bar.appendChild(link('Cambiar contraseña', '/login.html?change=1'));
    bar.appendChild(link('Salir', '#', async () => { try{ await api('POST', '/api/logout', {}); }catch(e){} location.href = '/login.html'; }));
    box.appendChild(bar);
    if(me.backup && me.backup.due){
      const sb = document.getElementById('statusBanner');
      if(sb){ const d = document.createElement('div'); d.className = 'banner banner-warn'; d.style.marginBottom = '16px';
        d.innerHTML = '<span>💾</span><span>' + (me.backup.days == null ? 'Aún no se ha descargado ningún respaldo.' : 'Hace ' + me.backup.days + ' días que no se descarga un respaldo.') + ' <a href="/admin.html" style="color:inherit;font-weight:700;">Descargar respaldo mensual</a></span>';
        sb.parentNode.insertBefore(d, sb.nextSibling); }
    }
  }
  meP.then(me => { if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => decorate(me)); else decorate(me); }).catch(() => {});

  window.claude = {
    use: async function(name){
      const me = await meP;
      if(name === 'db'){ startStream(); return dbNS; }
      if(name === 'sample') return me.ai && me.ai.enabled ? sampleNS : null;
      if(name === 'downloads') return dlNS;
      if(name === 'azure') return me.azure && me.azure.enabled ? azureNS : null;
      return null;
    }
  };
})();
