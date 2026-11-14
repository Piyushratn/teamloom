import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AiBudgetSummarySchema,
  AuthTokensResponseSchema,
  CopilotAskResponseSchema,
  OrganizationSummarySchema,
  ProjectSchema,
  ProposedActionSchema,
} from '@teamloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { runSqlMigrations } from '../src/database/migrate';

describe('AiAgentController E2E (Copilot RAG Citations, Approval-Gated Proposals, Budget Cap & Kill-Switch)', () => {
  let app: NestFastifyApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers Copilot questions with RAG citations, gates AI proposals until human approval, and enforces kill-switch & monthly budget caps', async () => {
    const suffix = Date.now();
    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: `ai_owner_${suffix}@teamloom.io`,
        password: 'StrongPassword123',
        fullName: 'AI Owner',
      },
    });
    expect(signupRes.statusCode).toBe(201);
    const owner = AuthTokensResponseSchema.parse(signupRes.json());

    // 1. Create Organization and Project ENG
    const orgRes = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Teamloom AI Lab', slug: `ai-lab-${suffix}` },
    });
    expect(orgRes.statusCode).toBe(201);
    const org = OrganizationSummarySchema.parse(orgRes.json());

    const projRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/projects`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        key: 'ENG',
        name: 'AI Platform Engineering',
        visibility: 'organization',
      },
    });
    expect(projRes.statusCode).toBe(201);
    const project = ProjectSchema.parse(projRes.json());

    // 2. Create a Knowledge Document so Copilot can cite it
    const docRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        projectId: project.id,
        title: 'Incident Response SLA Policy',
        contentMarkdown:
          '# Severity 1 SLA\nAll Severity-1 production incidents require acknowledgment within 15 minutes and root-cause postmortem within 24 hours.',
      },
    });
    expect(docRes.statusCode).toBe(201);

    // 3. Ask Copilot a question grounded in the workspace knowledge base
    const askRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/copilot/ask`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        question: 'What is our Severity 1 incident response SLA policy?',
        projectId: project.id,
      },
    });
    expect(askRes.statusCode).toBe(200);
    const copilot = CopilotAskResponseSchema.parse(askRes.json());
    expect(copilot.citations.length).toBeGreaterThanOrEqual(1);
    expect(copilot.citations[0]?.title).toContain(
      'Incident Response SLA Policy',
    );
    expect(copilot.answerMarkdown).toContain('Incident Response SLA Policy');

    // 4. Generate Sprint Plan Proposals -> verify they start as 'pending' and DO NOT mutate tasks yet
    const generateRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/proposals/generate`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        projectId: project.id,
        goal: 'Ship automated PagerDuty webhook alerting for Severity-1 incidents',
        mode: 'sprint_plan',
      },
    });
    expect(generateRes.statusCode).toBe(201);
    const proposals: Array<ReturnType<typeof ProposedActionSchema.parse>> =
      generateRes.json().proposals.map((p: unknown) =>
        ProposedActionSchema.parse(p),
      );
    expect(proposals.length).toBe(2);
    expect(proposals.every((p) => p.status === 'pending')).toBe(true);

    // Verify 0 tasks exist before human approval
    const tasksBeforeApproval = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(tasksBeforeApproval.json().tasks.length).toBe(0);

    // 5. Human-in-the-Loop Approval:
    //    - Approve the first proposal (`create_task`) -> creates task ENG-1 and sets status='executed'
    //    - Reject the second proposal (`create_document`) -> sets status='rejected' with no side effects
    const taskProposal = proposals.find((p) => p.actionType === 'create_task')!;
    const docProposal = proposals.find(
      (p) => p.actionType === 'create_document',
    )!;

    const approveRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/proposals/${taskProposal.id}/review`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        decision: 'approve',
        reviewNote: 'LGTM, adding to current sprint.',
      },
    });
    expect(approveRes.statusCode).toBe(200);
    const approvedAction = ProposedActionSchema.parse(approveRes.json());
    expect(approvedAction.status).toBe('executed');
    expect(approvedAction.executedResourceId).toBeTruthy();

    // Re-approving an already executed proposal must fail with 409 Conflict
    const duplicateApproveRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/proposals/${taskProposal.id}/review`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { decision: 'approve' },
    });
    expect(duplicateApproveRes.statusCode).toBe(409);

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/proposals/${docProposal.id}/review`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        decision: 'reject',
        reviewNote: 'We already have an SLA doc.',
      },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().status).toBe('rejected');

    // Verify that exactly 1 task (ENG-1) now exists in the project
    const tasksAfterApproval = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/projects/${project.id}/tasks`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(tasksAfterApproval.json().tasks.length).toBe(1);
    expect(tasksAfterApproval.json().tasks[0].displayId).toBe('ENG-1');

    // 6. Check AI Budget Ledger Summary (2 AI requests made so far: 1 copilot_ask + 1 sprint_plan)
    const budgetRes = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/ai/budget`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(budgetRes.statusCode).toBe(200);
    const budget = AiBudgetSummarySchema.parse(budgetRes.json());
    expect(budget.totalRequestsThisMonth).toBe(2);
    expect(budget.currentMonthSpendUsdCents).toBeGreaterThanOrEqual(2);

    // 7. Emergency Kill-Switch & Monthly Budget Cap Enforcement
    //    Toggle aiKillSwitch = true -> Copilot ask must immediately return 403 AI_KILL_SWITCH_ACTIVE
    await app.inject({
      method: 'PATCH',
      url: `/organizations/${org.id}/ai-settings`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { aiKillSwitch: true },
    });

    const killedAskRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/copilot/ask`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { question: 'Should be blocked by kill switch' },
    });
    expect(killedAskRes.statusCode).toBe(403);
    expect(killedAskRes.json().errorCode).toBe('AI_KILL_SWITCH_ACTIVE');

    // Turn off kill switch, but set monthlyAiBudgetUsdCents = 1 (below current spend of 2) -> 429 AI_MONTHLY_BUDGET_EXCEEDED
    await app.inject({
      method: 'PATCH',
      url: `/organizations/${org.id}/ai-settings`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { aiKillSwitch: false, monthlyAiBudgetUsdCents: 1 },
    });

    const overBudgetAskRes = await app.inject({
      method: 'POST',
      url: `/organizations/${org.id}/ai/copilot/ask`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { question: 'Should be blocked by exhausted monthly budget' },
    });
    expect(overBudgetAskRes.statusCode).toBe(429);
    expect(overBudgetAskRes.json().errorCode).toBe(
      'AI_MONTHLY_BUDGET_EXCEEDED',
    );
  });
});