'use strict';
/* Carga un respaldo JSON en la base (equivale a Administración → Restaurar, pero desde la terminal).
   Uso:  DATABASE_URL=... node scripts/import.js archivo.json [--reemplazar] [--con-usuarios] */
const fs = require('fs');
const db = require('../lib/db');
const store = require('../lib/store');
(async () => {
  const file = process.argv[2];
  if (!file) { console.error('Uso: node scripts/import.js archivo.json [--reemplazar] [--con-usuarios]'); process.exit(1); }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.collections) throw new Error('El archivo no parece un respaldo de QUQI_QA.');
  await db.init();
  const r = await store.restoreDocs(j.collections, process.argv.includes('--reemplazar') ? 'replace' : 'merge', 'import.js');
  console.log('Documentos escritos: ' + r.escritos + (r.borrados ? ', borrados: ' + r.borrados : ''), r.colecciones);
  if (process.argv.includes('--con-usuarios') && Array.isArray(j.users)) {
    for (const u of j.users) {
      await db.q(`INSERT INTO users(username,name,role,pass_hash,pv,must_change,active) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (username) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, pass_hash=EXCLUDED.pass_hash, pv=EXCLUDED.pv, must_change=EXCLUDED.must_change, active=EXCLUDED.active`,
        [u.username, u.name, u.role, u.pass_hash, u.pv || 1, !!u.must_change, u.active !== false]);
    }
    console.log('Usuarios restaurados: ' + j.users.length);
  }
  await db.pool.end();
})().catch(e => { console.error('Falló la importación:', e.message); process.exit(1); });
