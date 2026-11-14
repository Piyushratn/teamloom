import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from '@teamloom/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import { projects } from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async createProject(
    tenant: TenantMembershipContext,
    input: CreateProjectRequest,
    meta: RequestMetadata,
  ): Promise<Project> {
    const key = input.key.toUpperCase();

    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const existingKey = await tx.query.projects.findFirst({
          where: and(
            eq(projects.organizationId, tenant.organizationId),
            eq(projects.key, key),
          ),
        });

        if (existingKey) {
          throw new ConflictException({
            errorCode: 'PROJECT_KEY_TAKEN',
            message: `Project key '${key}' already exists in this organization`,
          });
        }

        const [created] = await tx
          .insert(projects)
          .values({
            organizationId: tenant.organizationId,
            key,
            name: input.name,
            description: input.description ?? null,
            visibility: input.visibility ?? 'organization',
            createdByUserId: tenant.userId,
          })
          .returning();

        if (!created) {
          throw new Error('Failed to insert project');
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'user',
            action: 'project.created',
            targetType: 'project',
            targetId: created.id,
            metadata: {
              key: created.key,
              name: created.name,
              visibility: created.visibility,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapProject(created);
      },
    );
  }

  async listProjects(
    tenant: TenantMembershipContext,
    includeArchived = false,
  ): Promise<Project[]> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const rows = await tx.query.projects.findMany({
          where: eq(projects.organizationId, tenant.organizationId),
          orderBy: [asc(projects.createdAt)],
        });

        return rows
          .filter((row) => {
            if (!includeArchived && row.archivedAt !== null) {
              return false;
            }
            return this.canTenantViewProject(tenant, row);
          })
          .map((row) => this.mapProject(row));
      },
    );
  }

  async getProjectById(
    tenant: TenantMembershipContext,
    projectId: string,
  ): Promise<Project> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const row = await this.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );
        return this.mapProject(row);
      },
    );
  }

  async updateProject(
    tenant: TenantMembershipContext,
    projectId: string,
    input: UpdateProjectRequest,
    meta: RequestMetadata,
  ): Promise<Project> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const existing = await this.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        const now = new Date();
        const archivedAt =
          input.archived === undefined
            ? existing.archivedAt
            : input.archived
              ? (existing.archivedAt ?? now)
              : null;

        const [updated] = await tx
          .update(projects)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.visibility !== undefined
              ? { visibility: input.visibility }
              : {}),
            archivedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, tenant.organizationId),
            ),
          )
          .returning();

        if (!updated) {
          throw new NotFoundException({
            errorCode: 'PROJECT_NOT_FOUND',
            message: 'Project not found',
          });
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'user',
            action: 'project.updated',
            targetType: 'project',
            targetId: updated.id,
            metadata: { ...input },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapProject(updated);
      },
    );
  }

  async deleteProject(
    tenant: TenantMembershipContext,
    projectId: string,
    meta: RequestMetadata,
  ): Promise<{ deleted: true }> {
    await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const existing = await this.assertAndGetAccessibleProject(
          tx,
          tenant,
          projectId,
        );

        await tx
          .delete(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.organizationId, tenant.organizationId),
            ),
          );

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'user',
            action: 'project.deleted',
            targetType: 'project',
            targetId: projectId,
            metadata: { key: existing.key, name: existing.name },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { deleted: true };
  }

  /**
   * Reusable helper used by ProjectsService, TasksService, and DocumentsService
   * to verify that a project exists in the active tenant and is visible to the caller.
   */
  async assertAndGetAccessibleProject(
    tx: DrizzleDb,
    tenant: TenantMembershipContext,
    projectId: string,
  ): Promise<typeof projects.$inferSelect> {
    const row = await tx.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, tenant.organizationId),
      ),
    });

    if (!row) {
      throw new NotFoundException({
        errorCode: 'PROJECT_NOT_FOUND',
        message: 'Project not found in this organization',
      });
    }

    if (!this.canTenantViewProject(tenant, row)) {
      throw new ForbiddenException({
        errorCode: 'PROJECT_ACCESS_DENIED',
        message: 'You do not have permission to access this project',
      });
    }

    return row;
  }

  canTenantViewProject(
    tenant: TenantMembershipContext,
    project: typeof projects.$inferSelect,
  ): boolean {
    if (tenant.role === 'owner' || tenant.role === 'admin') {
      return true;
    }

    if (tenant.role === 'guest') {
      return tenant.guestProjectIds.includes(project.id);
    }

    // Role is 'member'
    if (project.visibility === 'private') {
      return project.createdByUserId === tenant.userId;
    }

    return true;
  }

  private mapProject(row: typeof projects.$inferSelect): Project {
    return {
      id: row.id,
      organizationId: row.organizationId,
      key: row.key,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      taskSequence: row.taskSequence,
      createdByUserId: row.createdByUserId,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}