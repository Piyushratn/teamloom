import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.module';
import { runSqlMigrations } from '../src/database/migrate';

describe('SQL Migrations & Tenant RLS Context (Integration)', () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev';
  const appUrl =
    process.env.DATABASE_URL ??
    'postgresql://teamloom_app:teamloom_app_local_pw@localhost:5432/teamloom_dev';

  let dbService: DatabaseService;

  beforeAll(async () => {
    await runSqlMigrations(adminUrl);
    const pool = new Pool({ connectionString: appUrl, max: 5 });
    dbService = new DatabaseService(pool);
  });

  afterAll(async () => {
    await dbService.onModuleDestroy();
  });

  it('sets app_current_organization_id() inside withTenantContext and clears it outside', async () => {
    const testOrgId = '11111111-2222-3333-4444-555555555555';
    const testUserId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const insideResult = await dbService.withTenantContext(
      { organizationId: testOrgId, userId: testUserId },
      async (_tx, client) => {
        const res = await client.query<{ org_id: string; user_id: string }>(
          'SELECT app_current_organization_id() AS org_id, app_current_user_id() AS user_id',
        );
        return res.rows[0];
      },
    );

    expect(insideResult?.org_id).toBe(testOrgId);
    expect(insideResult?.user_id).toBe(testUserId);

    // Outside the transaction on the pool, the context must not leak
    const outsideRes = await dbService.pool.query<{ org_id: string | null }>(
      'SELECT app_current_organization_id() AS org_id',
    );
    expect(outsideRes.rows[0]?.org_id).toBeNull();
  });
});