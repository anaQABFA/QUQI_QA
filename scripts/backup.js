'use strict';
/* Copia completa de la base a un archivo JSON (datos + usuarios con sus claves ya cifradas).
   Uso:  DATABASE_URL=... node scripts/backup.js [archivo.json]
   Este archivo es sensible: guárdalo solo en un lugar privado y corporativo. */
const fs = require('fs');
const { q, pool } = require('../lib/db');
const store = require('../lib/store');
(async () => {
  const out = process.argv[2] || 'qa-certifica-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  const collections = await store.exportAll();
  const users = (await q('SELECT username, name, role, pass_hash, pv, must_change, active FROM users ORDER BY id')).rows;
  const n = Object.values(collections).reduce((t, c) => t + Object.keys(c).length, 0);
  fs.writeFileSync(out, JSON.stringify({ app: 'qa-certifica', formato: 1, exportadoEn: new Date().toISOString(), exportadoPor: 'scripts/backup.js', collections, users }));
  console.log('Respaldo escrito en ' + out + ': ' + n + ' documentos y ' + users.length + ' usuarios.');
  await pool.end();
})().catch(e => { console.error('Falló el respaldo:', e.message); process.exit(1); });
