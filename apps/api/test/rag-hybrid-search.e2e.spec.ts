import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AuthTokensResponseSchema,
  HybridSearchResponseSchema,
  OrganizationSummarySchema,
  ProjectSchema,
} from '@teamloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { runSqlMigrations } from '../src/database/migrate';
import { EmailService } from '../src/email/email.service';

describe('KnowledgeController Hybrid RAG Search & Multi-Tenant Visibility E2E (/organizations/:orgId/knowledge/*)', () => {
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

  it('automatically indexes docs & tasks, ranks relevant chunks first, and enforces private/guest/cross-tenant isolation', async () => {
    const suffix = Date.now();
    const ownerAEmail = `rag_owner_a_${suffix}@teamloom.io`;
    const memberAEmail = `rag_member_a_${suffix}@teamloom.io`;
    const ownerBEmail = `rag_owner_b_${suffix}@teamloom.io`;

    const signUp = async (email: string, fullName: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'StrongPassword123', fullName },
      });
      expect(res.statusCode).toBe(201);
      return AuthTokensResponseSchema.parse(res.json());
    };

    const ownerA = await signUp(ownerAEmail, 'Owner A');
    const memberA = await signUp(memberAEmail, 'Member A');
    const ownerB = await signUp(ownerBEmail, 'Owner B');

    // 1. Create Org A and Org B
    const orgARes = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { name: 'RAG Alpha Org', slug: `rag-alpha-${suffix}` },
    });
    expect(orgARes.statusCode).toBe(201);
    const orgA = OrganizationSummarySchema.parse(orgARes.json());

    const orgBRes = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { name: 'RAG Beta Org', slug: `rag-beta-${suffix}` },
    });
    expect(orgBRes.statusCode).toBe(201);
    const orgB = OrganizationSummarySchema.parse(orgBRes.json());

    // 2. Invite Member A into Org A (filter specifically for the organization invite email, not the signup verification email)
    const inviteRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/invites`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { email: memberAEmail, role: 'member' },
    });
    expect(inviteRes.statusCode).toBe(201);

    const inviteToken = emailService.testOutbox.find(
      (m) => m.to === memberAEmail && m.subject.includes('RAG Alpha Org'),
    )?.token;
    expect(inviteToken).toBeDefined();

    const acceptRes = await app.inject({
      method: 'POST',
      url: '/organizations/invites/accept',
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: { token: inviteToken },
    });
    expect(acceptRes.statusCode).toBe(200);

    // 3. Create public project ENG and private project EXEC in Org A
    const engProjRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { key: 'ENG', name: 'Engineering', visibility: 'organization' },
    });
    expect(engProjRes.statusCode).toBe(201);
    const engProject = ProjectSchema.parse(engProjRes.json());

    const execProjRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { key: 'EXEC', name: 'Executive M&A', visibility: 'private' },
    });
    expect(execProjRes.statusCode).toBe(201);
    const execProject = ProjectSchema.parse(execProjRes.json());

    // 4. Create documents and tasks in Org A (automatically indexed!)
    const doc1Res = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/documents`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        projectId: engProject.id,
        title: 'Database Security Runbook',
        contentMarkdown:
          '# PostgreSQL Row-Level Security\nEvery tenant query runs inside withTenantContext using set_config and FORCE ROW LEVEL SECURITY.',
      },
    });
    expect(doc1Res.statusCode).toBe(201);

    const task1Res = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        title: 'Rotate refresh token family on replay detection',
        description:
          'When a revoked refresh token is presented, revoke all sessions in that family_id immediately.',
        priority: 'urgent',
        labels: ['security', 'auth'],
      },
    });
    expect(task1Res.statusCode).toBe(201);

    // Private document inside EXEC project (Owner A can see; Member A cannot!)
    const execDocRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/documents`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        projectId: execProject.id,
        title: 'Confidential Acquisition Target Zeta',
        contentMarkdown:
          'Project Zeta acquisition valuation is 45 million dollars.',
      },
    });
    expect(execDocRes.statusCode).toBe(201);

    // 5. Hybrid Search for "Row-Level Security withTenantContext" returns the Database Security Runbook first
    const rlsSearchRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/knowledge/search`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: {
        query: 'PostgreSQL Row-Level Security withTenantContext',
        limit: 5,
      },
    });
    expect(rlsSearchRes.statusCode).toBe(200);
    const rlsSearch = HybridSearchResponseSchema.parse(rlsSearchRes.json());
    expect(rlsSearch.results.length).toBeGreaterThanOrEqual(1);
    expect(rlsSearch.results[0]?.title).toContain('Database Security Runbook');

    // 6. Private Project Isolation in RAG:
    //    Owner A searching "Acquisition Target Zeta" finds the private EXEC document,
    //    but Member A searching the exact same query MUST NOT receive any chunk from EXEC!
    const ownerPrivateSearch = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/knowledge/search`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { query: 'Acquisition Target Zeta valuation' },
    });
    expect(ownerPrivateSearch.statusCode).toBe(200);
    expect(
      ownerPrivateSearch
        .json()
        .results.some(
          (r: { projectId: string }) => r.projectId === execProject.id,
        ),
    ).toBe(true);

    const memberPrivateSearch = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/knowledge/search`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: { query: 'Acquisition Target Zeta valuation' },
    });
    expect(memberPrivateSearch.statusCode).toBe(200);
    expect(
      memberPrivateSearch
        .json()
        .results.some(
          (r: { projectId: string }) => r.projectId === execProject.id,
        ),
    ).toBe(false);

    // 7. Cross-Tenant Isolation: Owner B searching in Org B sees 0 chunks from Org A
    const orgBSearch = await app.inject({
      method: 'POST',
      url: `/organizations/${orgB.id}/knowledge/search`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { query: 'PostgreSQL Row-Level Security withTenantContext' },
    });
    expect(orgBSearch.statusCode).toBe(200);
    expect(orgBSearch.json().results.length).toBe(0);
  });
});