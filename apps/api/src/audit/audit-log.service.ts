import { Inject, Injectable } from '@nestjs/common';
import type { AuditLogEntry } from '@teamloom/contracts';
import { desc, eq } from 'drizzle-orm';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import { auditLogs } from '../database/schema';

export interface RecordAuditLogInput {
  organizationId: string;
  actorUserId?: string | null;
  actorType: 'user' | 'agent' | 'system';
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditLogService {
  constructor(@Inject(DatabaseService) private readonly dbService: DatabaseService) {}

  /**
   * Writes an immutable audit log entry inside an existing tenant transaction
   * or opens a new RLS-scoped tenant transaction.
   */
  async record(
    input: RecordAuditLogInput,
    existingTx?: DrizzleDb,
  ): Promise<AuditLogEntry> {
    const insertFn = async (tx: DrizzleDb): Promise<AuditLogEntry> => {
      const [row] = await tx
        .insert(auditLogs)
        .values({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId ?? null,
          actorType: input.actorType,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          metadata: input.metadata ?? {},
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        })
        .returning();

      if (!row) {
        throw new Error('Failed to write audit log entry');
      }

      return this.mapRow(row);
    };

    if (existingTx) {
      return insertFn(existingTx);
    }

    return this.dbService.withTenantContext(
      {
        organizationId: input.organizationId,
        userId: input.actorUserId ?? undefined,
      },
      async (tx) => insertFn(tx),
    );
  }

  async listForOrganization(
    organizationId: string,
    actorUserId: string,
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    return this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const rows = await tx.query.auditLogs.findMany({
          where: eq(auditLogs.organizationId, organizationId),
          orderBy: [desc(auditLogs.createdAt)],
          limit: Math.min(Math.max(limit, 1), 200),
        });

        return rows.map((r) => this.mapRow(r));
      },
    );
  }

  private mapRow(row: typeof auditLogs.$inferSelect): AuditLogEntry {
    return {
      id: row.id,
      organizationId: row.organizationId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata ?? {},
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    };
  }
}