import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';

export async function runSqlMigrations(adminDatabaseUrl: string): Promise<string[]> {
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  const appliedNow: string[] = [];

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS _schema_migrations (
          id SERIAL PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        GRANT SELECT ON TABLE _schema_migrations TO teamloom_app;
      `);

      const migrationsDir = path.resolve(__dirname, '../../drizzle/migrations');
      if (!fs.existsSync(migrationsDir)) {
        return appliedNow;
      }

      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const existing = await client.query(
          'SELECT 1 FROM _schema_migrations WHERE filename = $1',
          [file],
        );

        if (existing.rowCount && existing.rowCount > 0) {
          continue;
        }

        const sqlContent = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sqlContent);
          await client.query(
            'INSERT INTO _schema_migrations (filename) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
          appliedNow.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return appliedNow;
}

if (require.main === module) {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev';

  runSqlMigrations(url)
    .then((applied) => {
      console.info(
        applied.length > 0
          ? `Applied migrations: ${applied.join(', ')}`
          : 'Database migrations are already up to date.',
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}