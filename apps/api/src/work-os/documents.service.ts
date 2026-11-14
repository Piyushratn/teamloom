import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateDocumentRequest,
  Document,
  UpdateDocumentRequest,
} from '@teamloom/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import { documents, projects } from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';
import { ProjectsService } from './projects.service';

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(ProjectsService) private readonly projectsService: ProjectsService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async createDocument(
    tenant: TenantMembershipContext,
    input: CreateDocumentRequest,
    meta: RequestMetadata,
    actorType: 'user' | 'agent' = 'user',
  ): Promise<Document> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        if (input.projectId) {
          await this.projectsService.assertAndGetAccessibleProject(
            tx,
            tenant,
            input.projectId,
          );
        }

        const [created] = await tx
          .insert(documents)
          .values({
            organizationId: tenant.organizationId,
            projectId: input.projectId ?? null,
            title: input.title,
            contentMarkdown: input.contentMarkdown ?? '',
            version: 1,
            createdByUserId: tenant.userId,
            updatedByUserId: tenant.userId,
          })
          .returning();

        if (!created) {
          throw new Error('Failed to insert document');
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType,
            action: 'document.created',
            targetType: 'document',
            targetId: created.id,
            metadata: {
              projectId: created.projectId,
              title: created.title,
              version: created.version,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapDocument(created);
      },
    );
  }

  async listDocuments(
    tenant: TenantMembershipContext,
    projectId?: string,
    includeArchived = false,
  ): Promise<Document[]> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        if (projectId) {
          await this.projectsService.assertAndGetAccessibleProject(
            tx,
            tenant,
            projectId,
          );
        }

        const conditions = [eq(documents.organizationId, tenant.organizationId)];
        if (projectId) {
          conditions.push(eq(documents.projectId, projectId));
        }

        const [docRows, projectRows] = await Promise.all([
          tx.query.documents.findMany({
            where: and(...conditions),
            orderBy: [desc(documents.updatedAt)],
          }),
          tx.query.projects.findMany({
            where: eq(projects.organizationId, tenant.organizationId),
          }),
        ]);

        const projectById = new Map(projectRows.map((p) => [p.id, p]));

        return docRows
          .filter((doc) => {
            if (!includeArchived && doc.archivedAt !== null) {
              return false;
            }
            if (doc.projectId === null) {
              // Organization-wide documents are visible to internal members, not external guests
              return tenant.role !== 'guest';
            }
            const parentProject = projectById.get(doc.projectId);
            if (!parentProject) {
              return false;
            }
            return this.projectsService.canTenantViewProject(
              tenant,
              parentProject,
            );
          })
          .map((doc) => this.mapDocument(doc));
      },
    );
  }

  async getDocumentById(
    tenant: TenantMembershipContext,
    documentId: string,
  ): Promise<Document> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const doc = await this.assertAndGetAccessibleDocument(
          tx,
          tenant,
          documentId,
        );
        return this.mapDocument(doc);
      },
    );
  }

  async updateDocument(
    tenant: TenantMembershipContext,
    documentId: string,
    input: UpdateDocumentRequest,
    meta: RequestMetadata,
    actorType: 'user' | 'agent' = 'user',
  ): Promise<Document> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const existing = await this.assertAndGetAccessibleDocument(
          tx,
          tenant,
          documentId,
        );

        const now = new Date();
        const archivedAt =
          input.archived === undefined
            ? existing.archivedAt
            : input.archived
              ? (existing.archivedAt ?? now)
              : null;

        const [updated] = await tx
          .update(documents)
          .set({
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.contentMarkdown !== undefined
              ? { contentMarkdown: input.contentMarkdown }
              : {}),
            version: sql`${documents.version} + 1`,
            updatedByUserId: tenant.userId,
            archivedAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(documents.id, documentId),
              eq(documents.organizationId, tenant.organizationId),
            ),
          )
          .returning();

        if (!updated) {
          throw new NotFoundException({
            errorCode: 'DOCUMENT_NOT_FOUND',
            message: 'Document not found',
          });
        }

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType,
            action: 'document.updated',
            targetType: 'document',
            targetId: updated.id,
            metadata: {
              title: updated.title,
              version: updated.version,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return this.mapDocument(updated);
      },
    );
  }

  async deleteDocument(
    tenant: TenantMembershipContext,
    documentId: string,
    meta: RequestMetadata,
  ): Promise<{ deleted: true }> {
    await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const existing = await this.assertAndGetAccessibleDocument(
          tx,
          tenant,
          documentId,
        );

        await tx
          .delete(documents)
          .where(
            and(
              eq(documents.id, documentId),
              eq(documents.organizationId, tenant.organizationId),
            ),
          );

        await this.auditLog.record(
          {
            organizationId: tenant.organizationId,
            actorUserId: tenant.userId,
            actorType: 'user',
            action: 'document.deleted',
            targetType: 'document',
            targetId: documentId,
            metadata: {
              title: existing.title,
              projectId: existing.projectId,
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

  private async assertAndGetAccessibleDocument(
    tx: DrizzleDb,
    tenant: TenantMembershipContext,
    documentId: string,
  ): Promise<typeof documents.$inferSelect> {
    const doc = await tx.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.organizationId, tenant.organizationId),
      ),
    });

    if (!doc) {
      throw new NotFoundException({
        errorCode: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found in this organization',
      });
    }

    if (doc.projectId === null) {
      if (tenant.role === 'guest') {
        throw new ForbiddenException({
          errorCode: 'DOCUMENT_ACCESS_DENIED',
          message: 'Guest accounts cannot access organization-wide documents',
        });
      }
      return doc;
    }

    await this.projectsService.assertAndGetAccessibleProject(
      tx,
      tenant,
      doc.projectId,
    );
    return doc;
  }

  private mapDocument(row: typeof documents.$inferSelect): Document {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      title: row.title,
      contentMarkdown: row.contentMarkdown,
      version: row.version,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}