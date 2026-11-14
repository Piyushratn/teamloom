import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateTaskCommentRequest,
  CreateTaskRequest,
  Task,
  TaskComment,
  TaskPriority,
  TaskStatus,
  UpdateTaskRequest,
} from '@teamloom/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import {
  organizationMembers,
  projects,
  taskComments,
  tasks,
} from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';
import { KnowledgeRetrievalService } from '../rag/knowledge-retrieval.service';
import { ProjectsService } from './projects.service';

export interface ListTasksFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeUserId?: string;
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
    @Inject(KnowledgeRetrievalService)
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
  ) {}

  async createTask(
    tenant: TenantMembershipContext,
    projectId: string,
    input: CreateTaskRequest,
    meta: RequestMetadata,
    actorType: 'user' | 'agent' = 'user',
  ): Promise<Task> {
    const createdTask = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        if (input.assigneeUserId) {
          await this.assertValidOrgAssignee(
            tx,
            tenant.organizationId,
            input.assigneeUserId,
          );
        }

        const [seqRow] = await tx
          .update(projects)
          .set({
            taskSequence: sql`${projects.taskSequence} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, tenant.organizationId),
            ),
          )
          .returning({
            key: projects.key,
            taskSequence: projects.taskSequence,
          });

        if (!seqRow) {
          throw new NotFoundException({
            errorCode: 'PROJECT_NOT_FOUND',
            message: 'Project not found',
          });
        }

        const number = seqRow.taskSequence;
        const displayId = `${seqRow.key}-${number}`;

        const [created] = await tx
          .insert(tasks)
          .values({
            organizationId: tenant.organizationId,
            projectId,
            number,
            displayId,
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? 'todo',
            priority: input.priority ?? 'medium',
            assigneeUserId: input.assigneeUserId ?? null,
            reporterUserId: tenant.userId,
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
            labels: input.labels ?? [],
            position: number * 1000,
          })
          .returning();

        if (!created) {
          throw new Error('Failed to insert task');
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType,
            action: 'task.created',
            targetType: 'task',
            targetId: created.id,
            metadata: {
              projectId,
              displayId: created.displayId,
              title: created.title,
              status: created.status,
              priority: created.priority,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return created;
      },
    );

    await this.knowledgeRetrieval.indexTask({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      taskId: createdTask.id,
      projectId: createdTask.projectId,
      displayId: createdTask.displayId,
      title: createdTask.title,
      description: createdTask.description,
      status: createdTask.status,
      priority: createdTask.priority,
      labels: createdTask.labels ?? [],
    });

    return this.mapTask(createdTask);
  }

  async listTasks(
    tenant: TenantMembershipContext,
    projectId: string,
    filter: ListTasksFilter = {},
  ): Promise<Task[]> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const conditions = [
          eq(tasks.organizationId, tenant.organizationId),
          eq(tasks.projectId, projectId),
        ];

        if (filter.status) {
          conditions.push(eq(tasks.status, filter.status));
        }
        if (filter.priority) {
          conditions.push(eq(tasks.priority, filter.priority));
        }
        if (filter.assigneeUserId) {
          conditions.push(eq(tasks.assigneeUserId, filter.assigneeUserId));
        }

        const rows = await tx.query.tasks.findMany({
          where: and(...conditions),
          orderBy: [asc(tasks.position), asc(tasks.number)],
        });

        return rows.map((r) => this.mapTask(r));
      },
    );
  }

  async getTaskById(
    tenant: TenantMembershipContext,
    projectId: string,
    taskId: string,
  ): Promise<Task> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const row = await tx.query.tasks.findFirst({
          where: and(
            eq(tasks.id, taskId),
            eq(tasks.projectId, projectId),
            eq(tasks.organizationId, tenant.organizationId),
          ),
        });

        if (!row) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found in this project',
          });
        }

        return this.mapTask(row);
      },
    );
  }

  async updateTask(
    tenant: TenantMembershipContext,
    projectId: string,
    taskId: string,
    input: UpdateTaskRequest,
    meta: RequestMetadata,
    actorType: 'user' | 'agent' = 'user',
  ): Promise<Task> {
    const updatedTask = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const existing = await tx.query.tasks.findFirst({
          where: and(
            eq(tasks.id, taskId),
            eq(tasks.projectId, projectId),
            eq(tasks.organizationId, tenant.organizationId),
          ),
        });

        if (!existing) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found in this project',
          });
        }

        if (input.assigneeUserId) {
          await this.assertValidOrgAssignee(
            tx,
            tenant.organizationId,
            input.assigneeUserId,
          );
        }

        const [updated] = await tx
          .update(tasks)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
            ...(input.assigneeUserId !== undefined
              ? { assigneeUserId: input.assigneeUserId }
              : {}),
            ...(input.dueDate !== undefined
              ? { dueDate: input.dueDate ? new Date(input.dueDate) : null }
              : {}),
            ...(input.labels !== undefined ? { labels: input.labels } : {}),
            ...(input.position !== undefined
              ? { position: input.position }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.organizationId, tenant.organizationId),
            ),
          )
          .returning();

        if (!updated) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found',
          });
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType,
            action: 'task.updated',
            targetType: 'task',
            targetId: updated.id,
            metadata: {
              displayId: updated.displayId,
              previousStatus: existing.status,
              newStatus: updated.status,
              changes: { ...input },
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return updated;
      },
    );

    await this.knowledgeRetrieval.indexTask({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      displayId: updatedTask.displayId,
      title: updatedTask.title,
      description: updatedTask.description,
      status: updatedTask.status,
      priority: updatedTask.priority,
      labels: updatedTask.labels ?? [],
    });

    return this.mapTask(updatedTask);
  }

  async deleteTask(
    tenant: TenantMembershipContext,
    projectId: string,
    taskId: string,
    meta: RequestMetadata,
  ): Promise<{ deleted: true }> {
    await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const existing = await tx.query.tasks.findFirst({
          where: and(
            eq(tasks.id, taskId),
            eq(tasks.projectId, projectId),
            eq(tasks.organizationId, tenant.organizationId),
          ),
        });

        if (!existing) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found in this project',
          });
        }

        await this.knowledgeRetrieval.removeSourceChunks(
          tenant.organizationId,
          tenant.userId,
          'task',
          taskId,
          tx,
        );

        await tx
          .delete(tasks)
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.organizationId, tenant.organizationId),
            ),
          );

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'user',
            action: 'task.deleted',
            targetType: 'task',
            targetId: taskId,
            metadata: {
              displayId: existing.displayId,
              title: existing.title,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { deleted: true };
  }

  async addComment(
    tenant: TenantMembershipContext,
    projectId: string,
    taskId: string,
    input: CreateTaskCommentRequest,
    meta: RequestMetadata,
    authorType: 'user' | 'agent' = 'user',
  ): Promise<TaskComment> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const existingTask = await tx.query.tasks.findFirst({
          where: and(
            eq(tasks.id, taskId),
            eq(tasks.projectId, projectId),
            eq(tasks.organizationId, tenant.organizationId),
          ),
        });

        if (!existingTask) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found in this project',
          });
        }

        const [created] = await tx
          .insert(taskComments)
          .values({
            organizationId: tenant.organizationId,
            projectId,
            taskId,
            authorUserId: tenant.userId,
            authorType,
            body: input.body,
          })
          .returning();

        if (!created) {
          throw new Error('Failed to insert task comment');
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: authorType,
            action: 'task.comment_added',
            targetType: 'task_comment',
            targetId: created.id,
            metadata: {
              taskId,
              displayId: existingTask.displayId,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapComment(created);
      },
    );
  }

  async listComments(
    tenant: TenantMembershipContext,
    projectId: string,
    taskId: string,
  ): Promise<TaskComment[]> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        await this.projectsService.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const existingTask = await tx.query.tasks.findFirst({
          where: and(
            eq(tasks.id, taskId),
            eq(tasks.projectId, projectId),
            eq(tasks.organizationId, tenant.organizationId),
          ),
        });

        if (!existingTask) {
          throw new NotFoundException({
            errorCode: 'TASK_NOT_FOUND',
            message: 'Task not found in this project',
          });
        }

        const rows = await tx.query.taskComments.findMany({
          where: and(
            eq(taskComments.organizationId, tenant.organizationId),
            eq(taskComments.taskId, taskId),
          ),
          orderBy: [asc(taskComments.createdAt)],
        });

        return rows.map((r) => this.mapComment(r));
      },
    );
  }

  private async assertValidOrgAssignee(
    tx: DrizzleDb,
    organizationId: string,
    assigneeUserId: string,
  ): Promise<void> {
    const member = await tx.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, assigneeUserId),
      ),
    });

    if (!member) {
      throw new BadRequestException({
        errorCode: 'ASSIGNEE_NOT_IN_ORGANIZATION',
        message: 'Assignee must be a member of this organization',
      });
    }
  }

  private mapTask(row: typeof tasks.$inferSelect): Task {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      number: row.number,
      displayId: row.displayId,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assigneeUserId: row.assigneeUserId,
      reporterUserId: row.reporterUserId,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      labels: row.labels ?? [],
      position: row.position,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapComment(row: typeof taskComments.$inferSelect): TaskComment {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      taskId: row.taskId,
      authorUserId: row.authorUserId,
      authorType: row.authorType,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}