import { pool } from './index.js';

export async function runMigrations() {
  console.log('[DB] Running database migrations...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. webhook_jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id VARCHAR(255) NOT NULL,
        destination_url TEXT NOT NULL,
        destination_host VARCHAR(255) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 4,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_event_destination UNIQUE (event_id, destination_url)
      );
    `);

    // 2. Indexes for fast claiming and visibility recovery
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_claimable 
      ON webhook_jobs (status, next_attempt_at) 
      WHERE status IN ('queued', 'retrying');
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_stuck 
      ON webhook_jobs (status, locked_at) 
      WHERE status = 'processing';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at 
      ON webhook_jobs (created_at DESC);
    `);

    // 3. delivery_attempts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL REFERENCES webhook_jobs(id) ON DELETE CASCADE,
        attempt_number INT NOT NULL,
        status VARCHAR(32) NOT NULL,
        response_code INT,
        error_message TEXT,
        duration_ms INT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attempts_job_id 
      ON delivery_attempts(job_id, attempt_number ASC);
    `);

    await client.query('COMMIT');
    console.log('[DB] Migrations executed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Allow direct CLI invocation: `node src/db/migrate.js`
if (process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
