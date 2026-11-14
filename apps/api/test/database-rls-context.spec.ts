import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.module';
import { runSqlMigrations } from '../src/database/migrate';
import {
  auditLogs,
  organizationInvites,
  organizations,
  users,
} from '../src/database/schema';

describe('SQL Migrations & Tenant RLS Isolation (Integration)', () => {
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

    const outsideRes = await dbService.pool.query<{ org_id: string | null }>(
      'SELECT app_current_organization_id() AS org_id',
    );
    expect(outsideRes.rows[0]?.org_id).toBeNull();
  });

  it('enforces PostgreSQL RLS isolation between Org A and Org B and blocks audit_logs mutation', async () => {
    const suffix = Date.now();

    const [ownerA] = await dbService.db
      .insert(users)
      .values({
        email: `rls_owner_a_${suffix}@teamloom.io`,
        passwordHash: 'hash_a',
        fullName: 'Owner A',
      })
      .returning();

    const [ownerB] = await dbService.db
      .insert(users)
      .values({
        email: `rls_owner_b_${suffix}@teamloom.io`,
        passwordHash: 'hash_b',
        fullName: 'Owner B',
      })
      .returning();

    const [orgA] = await dbService.db
      .insert(organizations)
      .values({
        name: 'Org Alpha',
        slug: `org-alpha-${suffix}`,
        ownerId: ownerA!.id,
      })
      .returning();

    const [orgB] = await dbService.db
      .insert(organizations)
      .values({
        name: 'Org Beta',
        slug: `org-beta-${suffix}`,
        ownerId: ownerB!.id,
      })
      .returning();

    // Insert an invite and an audit log inside Org A's tenant context
    const insertedAudit = await dbService.withTenantContext(
      { organizationId: orgA!.id, userId: ownerA!.id },
      async (tx) => {
        await tx.insert(organizationInvites).values({
          organizationId: orgA!.id,
          email: `invitee_${suffix}@teamloom.io`,
          role: 'member',
          tokenHash: `token_hash_${suffix}`,
          invitedByUserId: ownerA!.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const [log] = await tx
          .insert(auditLogs)
          .values({
            organizationId: orgA!.id,
            actorUserId: ownerA!.id,
            actorType: 'user',
            action: 'org.created',
            targetType: 'organization',
            targetId: orgA!.id,
          })
          .returning();

        return log!;
      },
    );

    // 1. Querying from Org B's tenant context MUST return 0 rows from Org A
    await dbService.withTenantContext(
      { organizationId: orgB!.id, userId: ownerB!.id },
      async (tx) => {
        const visibleInvites = await tx.select().from(organizationInvites);
        const visibleLogs = await tx.select().from(auditLogs);

        expect(visibleInvites.length).toBe(0);
        expect(visibleLogs.length).toBe(0);

        // Attempting to INSERT a row tagged with Org A's ID while in Org B's context MUST fail RLS WITH CHECK
        await expect(
          tx.insert(auditLogs).values({
            organizationId: orgA!.id,
            actorUserId: ownerB!.id,
            actorType: 'user',
            action: 'org.spoofed',
            targetType: 'organization',
            targetId: orgA!.id,
          }),
        ).rejects.toThrow(/row-level security policy/);
      },
    );

    // 2. Attempting to UPDATE or DELETE audit_logs even inside Org A's context MUST fail (append-only)
    await dbService.withTenantContext(
      { organizationId: orgA!.id, userId: ownerA!.id },
      async (_tx, client) => {
        await expect(
          client.query('DELETE FROM audit_logs WHERE id = $1', [
            insertedAudit.id,
          ]),
        ).rejects.toThrow();
      },
    );
  });
});