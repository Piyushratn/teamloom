import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AuthTokensResponseSchema,
  OrganizationSummarySchema,
} from '@teamloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { runSqlMigrations } from '../src/database/migrate';
import { EmailService } from '../src/email/email.service';

describe('OrganizationsController HTTP Multi-Tenant Isolation & RBAC (/organizations/*)', () => {
  let app: NestFastifyApplication;
  let emailService: EmailService;

  beforeAll(async () => {
    const adminUrl =
      process.env.DATABASE_ADMIN_URL ??
      'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev';
    await runSqlMigrations(adminUrl);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    emailService = app.get(EmailService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('prevents cross-tenant access between Org A and Org B and enforces role permissions (owner vs member)', async () => {
    const suffix = Date.now();
    const ownerAEmail = `e2e_owner_a_${suffix}@teamloom.io`;
    const ownerBEmail = `e2e_owner_b_${suffix}@teamloom.io`;
    const memberAEmail = `e2e_member_a_${suffix}@teamloom.io`;

    // 1. Sign up Owner A, Owner B, and Member A
    const signupA = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: ownerAEmail,
        password: 'StrongPassword123',
        fullName: 'Owner A',
      },
    });
    const tokensA = AuthTokensResponseSchema.parse(signupA.json());

    const signupB = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: ownerBEmail,
        password: 'StrongPassword123',
        fullName: 'Owner B',
      },
    });
    const tokensB = AuthTokensResponseSchema.parse(signupB.json());

    const signupMember = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: memberAEmail,
        password: 'StrongPassword123',
        fullName: 'Member A',
      },
    });
    const tokensMember = AuthTokensResponseSchema.parse(signupMember.json());

    // 2. Owner A creates Org A; Owner B creates Org B
    const createOrgARes = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${tokensA.accessToken}` },
      payload: { name: 'Alpha Corp', slug: `alpha-corp-${suffix}` },
    });
    expect(
      createOrgARes.statusCode,
      JSON.stringify(createOrgARes.json()),
    ).toBe(201);
    const orgA = OrganizationSummarySchema.parse(createOrgARes.json());

    const createOrgBRes = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${tokensB.accessToken}` },
      payload: { name: 'Beta Corp', slug: `beta-corp-${suffix}` },
    });
    expect(
      createOrgBRes.statusCode,
      JSON.stringify(createOrgBRes.json()),
    ).toBe(201);
    const orgB = OrganizationSummarySchema.parse(createOrgBRes.json());

    // 3. CROSS-TENANT ISOLATION: Owner B tries to read Org A, list Org A's members, or read Org A's audit logs -> 403 ORG_ACCESS_DENIED
    const crossGetOrg = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}`,
      headers: { authorization: `Bearer ${tokensB.accessToken}` },
    });
    expect(crossGetOrg.statusCode).toBe(403);
    expect(crossGetOrg.json().errorCode).toBe('ORG_ACCESS_DENIED');

    const crossListMembers = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/members`,
      headers: { authorization: `Bearer ${tokensB.accessToken}` },
    });
    expect(crossListMembers.statusCode).toBe(403);

    const crossAuditLogs = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/audit-logs`,
      headers: { authorization: `Bearer ${tokensB.accessToken}` },
    });
    expect(crossAuditLogs.statusCode).toBe(403);

    // 4. Owner A invites Member A as 'member' and Member A accepts
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/invites`,
      headers: { authorization: `Bearer ${tokensA.accessToken}` },
      payload: { email: memberAEmail, role: 'member' },
    });
    expect(inviteRes.statusCode, JSON.stringify(inviteRes.json())).toBe(201);

    const inviteEmail = emailService.testOutbox.find(
      (m) => m.to === memberAEmail && m.subject.includes('Alpha Corp'),
    );
    expect(inviteEmail?.token).toBeDefined();

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/organizations/invites/accept',
      headers: { authorization: `Bearer ${tokensMember.accessToken}` },
      payload: { token: inviteEmail!.token! },
    });
    expect(acceptRes.statusCode, JSON.stringify(acceptRes.json())).toBe(200);

    // 5. RBAC ENFORCEMENT: Member A can read Org A and list members, but CANNOT invite others, change AI settings, or read audit logs
    const memberReadOrg = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}`,
      headers: { authorization: `Bearer ${tokensMember.accessToken}` },
    });
    expect(memberReadOrg.statusCode).toBe(200);
    expect(memberReadOrg.json().myRole).toBe('member');

    const memberTryInvite = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/invites`,
      headers: { authorization: `Bearer ${tokensMember.accessToken}` },
      payload: { email: `unauth_${suffix}@teamloom.io`, role: 'member' },
    });
    expect(memberTryInvite.statusCode).toBe(403);
    expect(memberTryInvite.json().errorCode).toBe(
      'INSUFFICIENT_ROLE_PERMISSION',
    );

    const memberTryAiSettings = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgA.id}/ai-settings`,
      headers: { authorization: `Bearer ${tokensMember.accessToken}` },
      payload: { aiKillSwitch: true },
    });
    expect(memberTryAiSettings.statusCode).toBe(403);

    const memberTryAudit = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/audit-logs`,
      headers: { authorization: `Bearer ${tokensMember.accessToken}` },
    });
    expect(memberTryAudit.statusCode).toBe(403);
    expect(memberTryAudit.json().errorCode).toBe(
      'INSUFFICIENT_ROLE_PERMISSION',
    );

    // 6. Owner A updates AI budget & kill-switch settings and verifies the audit log
    const updateAiRes = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgA.id}/ai-settings`,
      headers: { authorization: `Bearer ${tokensA.accessToken}` },
      payload: {
        aiKillSwitch: true,
        monthlyAiBudgetUsdCents: 2500,
      },
    });
    expect(updateAiRes.statusCode).toBe(200);
    expect(updateAiRes.json().aiKillSwitch).toBe(true);
    expect(updateAiRes.json().monthlyAiBudgetUsdCents).toBe(2500);

    // 7. Owner A can read Org A's audit logs and sees zero logs from Org B
    const ownerAAudit = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/audit-logs`,
      headers: { authorization: `Bearer ${tokensA.accessToken}` },
    });
    expect(ownerAAudit.statusCode).toBe(200);
    const logs: Array<{ organizationId: string; action: string }> =
      ownerAAudit.json().auditLogs;
    expect(logs.length).toBeGreaterThanOrEqual(4);
    expect(logs.some((l) => l.action === 'org.ai_settings_updated')).toBe(
      true,
    );
    expect(logs.every((l) => l.organizationId === orgA.id)).toBe(true);
    expect(logs.some((l) => l.organizationId === orgB.id)).toBe(false);
  });
});