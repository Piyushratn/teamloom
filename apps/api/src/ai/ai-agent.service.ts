import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreateDocumentRequestSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  type AiBudgetSummary,
  type CopilotAskRequest,
  type CopilotAskResponse,
  type ProposedAction,
  type ProposedActionStatus,
  type ProposeProjectActionsRequest,
  type ReviewProposedActionRequest,
} from '@teamloom/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import { DatabaseService } from '../database/database.module';
import { proposedActions, tasks } from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';
import { KnowledgeRetrievalService } from '../rag/knowledge-retrieval.service';
import { DocumentsService } from '../work-os/documents.service';
import { ProjectsService } from '../work-os/projects.service';
import { TasksService } from '../work-os/tasks.service';
import { LlmGatewayService } from './llm-gateway.service';

@Injectable()
export class AiAgentService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(LlmGatewayService) private readonly llmGateway: LlmGatewayService,
    @Inject(KnowledgeRetrievalService)
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(TasksService) private readonly tasksService: TasksService,
    @Inject(DocumentsService)
    private readonly documentsService: DocumentsService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async getBudgetSummary(
    tenant: TenantMembershipContext,
  ): Promise<AiBudgetSummary> {
    return this.llmGateway.getBudgetSummary(tenant);
  }

  /**
   * RAG-grounded Copilot question answering with source citations and token ledger recording.
   */
  async askCopilot(
    tenant: TenantMembershipContext,
    input: CopilotAskRequest,
    meta: RequestMetadata,
  ): Promise<CopilotAskResponse> {
    const searchResult = await this.knowledgeRetrieval.hybridSearch(tenant, {
      query: input.question,
      projectId: input.projectId,
      sourceTypes: ['document', 'task'],
      limit: 5,
    });

    const completion = await this.llmGateway.generateCopilotAnswer({
      tenant,
      question: input.question,
      contextChunks: searchResult.results,
    });

    await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'agent',
            action: 'ai.copilot_asked',
            targetType: 'organization',
            targetId: tenant.organizationId,
            metadata: {
              projectId: input.projectId ?? null,
              citationsCount: searchResult.results.length,
              tokensUsed: completion.totalTokens,
              costUsdCents: completion.costUsdCents,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return {
      answerMarkdown: completion.text,
      citations: searchResult.results.map((c) => ({
        chunkId: c.chunkId,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        title: c.title,
        hybridScore: c.hybridScore,
      })),
      model: completion.model,
      tokensUsed: completion.totalTokens,
      costUsdCents: completion.costUsdCents,
    };
  }

  /**
   * Generates structured project action proposals (`create_task`, `update_task`, `create_document`)
   * and stores them with `status = 'pending'` in `proposed_actions` awaiting human approval.
   */
  async generateProposals(
    tenant: TenantMembershipContext,
    input: ProposeProjectActionsRequest,
    meta: RequestMetadata,
  ): Promise<{ proposals: ProposedAction[]; tokensUsed: number }> {
    const { project, existingTasks } = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const proj = await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          input.projectId,
        );
        const taskRows = await tx.query.tasks.findMany({
          where: and(
            eq(tasks.organizationId, tenant.organizationId),
            eq(tasks.projectId, input.projectId),
          ),
        });
        return { project: proj, existingTasks: taskRows };
      },
    );

    const { proposals: drafts, usage } =
      await this.llmGateway.generateProjectActionProposals({
        tenant,
        projectKey: project.key,
        projectName: project.name,
        goal: input.goal,
        mode: input.mode,
        existingTasksSummary: existingTasks.map((t) => ({
          id: t.id,
          displayId: t.displayId,
          title: t.title,
          status: t.status,
          priority: t.priority,
        })),
      });

    const inserted = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const rows = await tx
          .insert(proposedActions)
          .values(
            drafts.map((d) => ({
              organizationId: tenant.organizationId,
              projectId: project.id,
              requestedByUserId: tenant.userId,
              actionType: d.actionType,
              title: d.title,
              rationale: d.rationale,
              payload: d.payload,
              status: 'pending' as const,
            })),
          )
          .returning();

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'agent',
            action: 'ai.proposals_generated',
            targetType: 'project',
            targetId: project.id,
            metadata: {
              mode: input.mode,
              goal: input.goal,
              count: rows.length,
              tokensUsed: usage.totalTokens,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return rows;
      },
    );

    return {
      proposals: inserted.map((r) => this.mapProposal(r)),
      tokensUsed: usage.totalTokens,
    };
  }

  async listProposals(
    tenant: TenantMembershipContext,
    filter: { projectId?: string; status?: ProposedActionStatus } = {},
  ): Promise<ProposedAction[]> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        if (filter.projectId) {
          await this.projectsService.assertAndGetAccessibleProject(
            tx,
            tenant,
            filter.projectId,
          );
        }

        const conditions = [
          eq(proposedActions.organizationId, tenant.organizationId),
        ];
        if (filter.projectId) {
          conditions.push(eq(proposedActions.projectId, filter.projectId));
        }
        if (filter.status) {
          conditions.push(eq(proposedActions.status, filter.status));
        }

        const rows = await tx.query.proposedActions.findMany({
          where: and(...conditions),
          orderBy: [desc(proposedActions.createdAt)],
        });

        return rows.map((r) => this.mapProposal(r));
      },
    );
  }

  /**
   * Human-in-the-loop review endpoint.
   * - If `decision === 'reject'`, marks the proposal as `'rejected'` without side-effects.
   * - If `decision === 'approve'`, executes the underlying Work OS mutation (`create_task`, `update_task`, `create_document`),
   *   records `executedResourceId`, marks status `'executed'`, and writes an immutable audit log entry.
   */
  async reviewProposal(
    tenant: TenantMembershipContext,
    actionId: string,
    input: ReviewProposedActionRequest,
    meta: RequestMetadata,
  ): Promise<ProposedAction> {
    const existing = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const row = await tx.query.proposedActions.findFirst({
          where: and(
            eq(proposedActions.id, actionId),
            eq(proposedActions.organizationId, tenant.organizationId),
          ),
        });

        if (!row) {
          throw new NotFoundException({
            errorCode: 'PROPOSED_ACTION_NOT_FOUND',
            message: 'Proposed AI action not found in this organization',
          });
        }

        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          row.projectId,
        );

        if (row.status !== 'pending') {
          throw new ConflictException({
            errorCode: 'PROPOSED_ACTION_ALREADY_REVIEWED',
            message: `Proposed action has already been ${row.status}`,
          });
        }

        return row;
      },
    );

    if (input.decision === 'reject') {
      return this.dbService.withTenantContext(
        { organizationId: tenant.organizationId, userId: tenant.userId },
        async (tx) => {
          const now = new Date();
          const [rejected] = await tx
            .update(proposedActions)
            .set({
              status: 'rejected',
              reviewedByUserId: tenant.userId,
              reviewNote: input.reviewNote ?? null,
              reviewedAt: now,
              updatedAt: now,
            })
            .where(eq(proposedActions.id, actionId))
            .returning();

          if (!rejected) {
            throw new NotFoundException({
              errorCode: 'PROPOSED_ACTION_NOT_FOUND',
              message: 'Proposed action not found',
            });
          }

          await this.auditLog.record(
            {
              organizationId: tenant.organizationId,
              actorUserId: tenant.userId,
              actorType: 'user',
              action: 'ai.proposal_rejected',
              targetType: 'proposed_action',
              targetId: rejected.id,
              metadata: {
                actionType: rejected.actionType,
                title: rejected.title,
                reviewNote: input.reviewNote ?? null,
              },
              ipAddress: meta.ipAddress,
              userAgent: meta.userAgent,
            },
            tx,
          );

          return this.mapProposal(rejected);
        },
      );
    }

    // decision === 'approve': execute the approved Work OS action
    let executedResourceId: string;

    if (existing.actionType === 'create_task') {
      const parsedTask = CreateTaskRequestSchema.safeParse(existing.payload);
      if (!parsedTask.success) {
        throw new BadRequestException({
          errorCode: 'INVALID_PROPOSAL_PAYLOAD',
          message: 'Proposed create_task payload is invalid',
        });
      }
      const createdTask = await this.tasksService.createTask(
        tenant,
        existing.projectId,
        parsedTask.data,
        meta,
        'agent',
      );
      executedResourceId = createdTask.id;
    } else if (existing.actionType === 'update_task') {
      const rawTaskId = existing.payload.taskId;
      if (typeof rawTaskId !== 'string') {
        throw new BadRequestException({
          errorCode: 'INVALID_PROPOSAL_PAYLOAD',
          message: 'Proposed update_task payload is missing taskId',
        });
      }
      const parsedUpdate = UpdateTaskRequestSchema.safeParse(existing.payload);
      if (!parsedUpdate.success) {
        throw new BadRequestException({
          errorCode: 'INVALID_PROPOSAL_PAYLOAD',
          message: 'Proposed update_task payload is invalid',
        });
      }
      const updatedTask = await this.tasksService.updateTask(
        tenant,
        existing.projectId,
        rawTaskId,
        parsedUpdate.data,
        meta,
        'agent',
      );
      executedResourceId = updatedTask.id;
    } else {
      // 'create_document'
      const parsedDoc = CreateDocumentRequestSchema.safeParse({
        ...existing.payload,
        projectId: existing.projectId,
      });
      if (!parsedDoc.success) {
        throw new BadRequestException({
          errorCode: 'INVALID_PROPOSAL_PAYLOAD',
          message: 'Proposed create_document payload is invalid',
        });
      }
      const createdDoc = await this.documentsService.createDocument(
        tenant,
        parsedDoc.data,
        meta,
        'agent',
      );
      executedResourceId = createdDoc.id;
    }

    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const now = new Date();
        const [executed] = await tx
          .update(proposedActions)
          .set({
            status: 'executed',
            reviewedByUserId: tenant.userId,
            reviewNote: input.reviewNote ?? null,
            executedResourceId,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(eq(proposedActions.id, actionId))
          .returning();

        if (!executed) {
          throw new NotFoundException({
            errorCode: 'PROPOSED_ACTION_NOT_FOUND',
            message: 'Proposed action not found',
          });
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'agent',
            action: 'ai.proposal_approved_and_executed',
            targetType: 'proposed_action',
            targetId: executed.id,
            metadata: {
              actionType: executed.actionType,
              title: executed.title,
              executedResourceId,
              reviewedByUserId: tenant.userId,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapProposal(executed);
      },
    );
  }

  private mapProposal(row: typeof proposedActions.$inferSelect): ProposedAction {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      requestedByUserId: row.requestedByUserId,
      actionType: row.actionType,
      title: row.title,
      rationale: row.rationale,
      payload: row.payload ?? {},
      status: row.status,
      reviewedByUserId: row.reviewedByUserId,
      reviewNote: row.reviewNote,
      executedResourceId: row.executedResourceId,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}