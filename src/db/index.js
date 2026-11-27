import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: config.databaseUrl.includes('render.com') || config.databaseUrl.includes('neon.tech') || config.databaseUrl.includes('supabase.co')
    ? { rejectUnauthorized: false }
    : false
});

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err.message);
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}
