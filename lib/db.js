'use strict';
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('Falta la variable DATABASE_URL (cadena de conexión de Postgres / Neon).'); process.exit(1); }

const local = /localhost|127\.0\.0\.1/.test(url);
const pool = new Pool({
  connectionString: url,
  max: 6,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
  ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: true }
});
// Neon duerme la base cuando no hay uso: las conexiones ociosas se cierran y eso no debe tumbar el servidor.
pool.on('error', e => console.error('[pg] conexión ociosa cerrada:', e.message));

const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS docs (
    col text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    PRIMARY KEY (col, id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    username text NOT NULL UNIQUE,
    name text NOT NULL,
    role text NOT NULL DEFAULT 'analista',
    pass_hash text NOT NULL,
    pv integer NOT NULL DEFAULT 1,
    must_change boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login timestamptz
  )`);
  await q(`CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
}

module.exports = { pool, q, init };
