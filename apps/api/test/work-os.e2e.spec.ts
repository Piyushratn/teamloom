import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AuthTokensResponseSchema,
  DocumentSchema,
  OrganizationSummarySchema,
  ProjectSchema,
  TaskCommentSchema,
  TaskSchema,
} from '@teamloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { runSqlMigrations } from '../src/database/migrate';
import { EmailService } from '../src/email/email.service';

describe('WorkOsController HTTP E2E (Projects, Tasks, Comments, Documents, Guest & Cross-Tenant Isolation)', () => {
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

  it('manages projects, sequential tasks (ENG-1, ENG-2), comments, versioned docs, and enforces guest/private/cross-tenant boundaries', async () => {
    const suffix = Date.now();
    const ownerAEmail = `work_owner_a_${suffix}@teamloom.io`;
    const memberAEmail = `work_member_a_${suffix}@teamloom.io`;
    const guestAEmail = `work_guest_a_${suffix}@teamloom.io`;
    const ownerBEmail = `work_owner_b_${suffix}@teamloom.io`;

    const signUpUser = async (email: string, fullName: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'StrongPassword123', fullName },
      });
      expect(res.statusCode).toBe(201);
      return AuthTokensResponseSchema.parse(res.json());
    };

    const ownerA = await signUpUser(ownerAEmail, 'Owner A');
    const memberA = await signUpUser(memberAEmail, 'Member A');
    const guestA = await signUpUser(guestAEmail, 'Guest A');
    const ownerB = await signUpUser(ownerBEmail, 'Owner B');

    // 1. Create Org A and Org B
    const createOrgA = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { name: 'Teamloom WorkOS Org A', slug: `workos-a-${suffix}` },
    });
    expect(createOrgA.statusCode).toBe(201);
    const orgA = OrganizationSummarySchema.parse(createOrgA.json());

    const createOrgB = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
      payload: { name: 'Teamloom WorkOS Org B', slug: `workos-b-${suffix}` },
    });
    expect(createOrgB.statusCode).toBe(201);
    const orgB = OrganizationSummarySchema.parse(createOrgB.json());

    // 2. Owner A creates two projects in Org A:
    //    - ENG (visibility: 'organization')
    //    - SEC (visibility: 'private')
    const createEngRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        key: 'eng',
        name: 'Core Engineering',
        description: 'Main product engineering backlog',
        visibility: 'organization',
      },
    });
    expect(createEngRes.statusCode).toBe(201);
    const engProject = ProjectSchema.parse(createEngRes.json());
    expect(engProject.key).toBe('ENG');

    const createSecRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        key: 'sec',
        name: 'Security & Executive',
        visibility: 'private',
      },
    });
    expect(createSecRes.statusCode).toBe(201);
    const secProject = ProjectSchema.parse(createSecRes.json());

    // 3. Invite Member A (role: 'member') and Guest A (role: 'guest', allowed only on engProject.id)
    const inviteMemberRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/invites`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { email: memberAEmail, role: 'member' },
    });
    expect(inviteMemberRes.statusCode).toBe(201);

    const memberInviteToken = emailService.testOutbox.find(
      (m) => m.to === memberAEmail && m.subject.includes('invited'),
    )?.token;
    expect(memberInviteToken).toBeDefined();

    const acceptMemberRes = await app.inject({
      method: 'POST',
      url: '/organizations/invites/accept',
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: { token: memberInviteToken },
    });
    expect(acceptMemberRes.statusCode).toBe(200);

    const inviteGuestRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/invites`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        email: guestAEmail,
        role: 'guest',
        guestProjectIds: [engProject.id],
      },
    });
    expect(inviteGuestRes.statusCode).toBe(201);

    const guestInviteToken = emailService.testOutbox.find(
      (m) => m.to === guestAEmail && m.subject.includes('invited'),
    )?.token;
    expect(guestInviteToken).toBeDefined();

    const acceptGuestRes = await app.inject({
      method: 'POST',
      url: '/organizations/invites/accept',
      headers: { authorization: `Bearer ${guestA.accessToken}` },
      payload: { token: guestInviteToken },
    });
    expect(acceptGuestRes.statusCode).toBe(200);

    // 4. Visibility verification:
    //    - Owner A sees both ENG and SEC (2 projects)
    //    - Member A sees only ENG (cannot see Owner A's private SEC project)
    //    - Guest A sees only ENG (via guestProjectIds)
    const memberProjectsRes = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/projects`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
    });
    expect(memberProjectsRes.statusCode).toBe(200);
    expect(
      memberProjectsRes.json().projects.map((p: { key: string }) => p.key),
    ).toEqual(['ENG']);

    // Member A trying to directly fetch private SEC project -> 403 PROJECT_ACCESS_DENIED
    const memberGetSecRes = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/projects/${secProject.id}`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
    });
    expect(memberGetSecRes.statusCode).toBe(403);
    expect(memberGetSecRes.json().errorCode).toBe('PROJECT_ACCESS_DENIED');

    // Guest A trying to directly fetch SEC project -> 403 GUEST_PROJECT_RESTRICTED
    const guestGetSecRes = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/projects/${secProject.id}`,
      headers: { authorization: `Bearer ${guestA.accessToken}` },
    });
    expect(guestGetSecRes.statusCode).toBe(403);

    // 5. Tasks & Atomic Display IDs (ENG-1, ENG-2)
    const task1Res = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: {
        title: 'Build pgvector semantic chunking pipeline',
        priority: 'high',
        assigneeUserId: memberA.user.id,
        labels: ['ai', 'rag'],
      },
    });
    expect(task1Res.statusCode).toBe(201);
    const task1 = TaskSchema.parse(task1Res.json());
    expect(task1.displayId).toBe('ENG-1');
    expect(task1.number).toBe(1);

    const task2Res = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        title: 'Add human-in-the-loop approval modal',
        priority: 'urgent',
      },
    });
    expect(task2Res.statusCode).toBe(201);
    const task2 = TaskSchema.parse(task2Res.json());
    expect(task2.displayId).toBe('ENG-2');
    expect(task2.number).toBe(2);

    // Assigning a task to Owner B (who is NOT in Org A) must fail with 400 ASSIGNEE_NOT_IN_ORGANIZATION
    const badAssigneeRes = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks/${task1.id}`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: { assigneeUserId: ownerB.user.id },
    });
    expect(badAssigneeRes.statusCode).toBe(400);
    expect(badAssigneeRes.json().errorCode).toBe(
      'ASSIGNEE_NOT_IN_ORGANIZATION',
    );

    // Guest A can update status on a task in their allowed project (ENG) and add a comment,
    // but CANNOT create a new task
    const guestCreateTask = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks`,
      headers: { authorization: `Bearer ${guestA.accessToken}` },
      payload: { title: 'Unauthorized guest task' },
    });
    expect(guestCreateTask.statusCode).toBe(403);

    const guestUpdateTask = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks/${task1.id}`,
      headers: { authorization: `Bearer ${guestA.accessToken}` },
      payload: { status: 'in_progress' },
    });
    expect(guestUpdateTask.statusCode).toBe(200);
    expect(guestUpdateTask.json().status).toBe('in_progress');

    const commentRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks/${task1.id}/comments`,
      headers: { authorization: `Bearer ${guestA.accessToken}` },
      payload: { body: 'Started reviewing the chunking spec.' },
    });
    expect(commentRes.statusCode).toBe(201);
    const comment = TaskCommentSchema.parse(commentRes.json());
    expect(comment.body).toContain('chunking spec');

    // 6. Versioned Knowledge Documents (Org-level & Project-level)
    const createOrgDocRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/documents`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
      payload: {
        title: 'Company Security Handbook',
        contentMarkdown: '# Security Policy\nAll secrets must be rotated.',
      },
    });
    expect(createOrgDocRes.statusCode).toBe(201);
    const orgDoc = DocumentSchema.parse(createOrgDocRes.json());
    expect(orgDoc.version).toBe(1);
    expect(orgDoc.projectId).toBeNull();

    const createProjDocRes = await app.inject({
      method: 'POST',
      url: `/organizations/${orgA.id}/documents`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: {
        projectId: engProject.id,
        title: 'ENG Architecture RFC',
        contentMarkdown: '## Overview\nHybrid search with pgvector.',
      },
    });
    expect(createProjDocRes.statusCode).toBe(201);
    const projDoc = DocumentSchema.parse(createProjDocRes.json());

    // Updating the project document increments version to 2
    const updateDocRes = await app.inject({
      method: 'PATCH',
      url: `/organizations/${orgA.id}/documents/${projDoc.id}`,
      headers: { authorization: `Bearer ${memberA.accessToken}` },
      payload: {
        contentMarkdown:
          '## Overview\nHybrid search with pgvector and Gemini embeddings.',
      },
    });
    expect(updateDocRes.statusCode).toBe(200);
    expect(updateDocRes.json().version).toBe(2);

    // Guest A listing documents only sees the ENG project doc, NOT the org-wide Security Handbook
    const guestDocsRes = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/documents`,
      headers: { authorization: `Bearer ${guestA.accessToken}` },
    });
    expect(guestDocsRes.statusCode).toBe(200);
    expect(
      guestDocsRes.json().documents.map((d: { id: string }) => d.id),
    ).toEqual([projDoc.id]);

    // 7. Cross-Tenant Isolation: Owner B trying to access Org A's projects or tasks gets 403
    const crossTenantTasks = await app.inject({
      method: 'GET',
      url: `/organizations/${orgA.id}/projects/${engProject.id}/tasks`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(crossTenantTasks.statusCode).toBe(403);

    // Owner B listing projects in Org B sees 0 projects from Org A
    const orgBProjects = await app.inject({
      method: 'GET',
      url: `/organizations/${orgB.id}/projects`,
      headers: { authorization: `Bearer ${ownerB.accessToken}` },
    });
    expect(orgBProjects.statusCode).toBe(200);
    expect(orgBProjects.json().projects.length).toBe(0);
  });
});