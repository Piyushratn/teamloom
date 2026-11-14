import { Inject, Injectable } from '@nestjs/common';
import type {
  HybridSearchRequest,
  HybridSearchResponse,
  KnowledgeSearchResultItem,
  KnowledgeSourceType,
} from '@teamloom/contracts';
import { and, eq } from 'drizzle-orm';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import {
  documents,
  knowledgeChunks,
  projects,
  tasks,
} from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';
import { ChunkerService } from './chunker.service';
import { EmbeddingService } from './embedding.service';

interface RawHybridRow {
  chunk_id: string;
  source_type: KnowledgeSourceType;
  source_id: string;
  project_id: string | null;
  chunk_index: number;
  title: string;
  content: string;
  semantic_score: number | string;
  lexical_score: number | string;
  hybrid_score: number | string;
}

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(ChunkerService) private readonly chunker: ChunkerService,
    @Inject(EmbeddingService)
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Indexes or re-indexes a Markdown Document into `knowledge_chunks` inside an existing
   * or new RLS-scoped tenant transaction.
   */
  async indexDocument(
    params: {
      organizationId: string;
      userId: string;
      documentId: string;
      projectId: string | null;
      title: string;
      contentMarkdown: string;
    },
    existingTx?: DrizzleDb,
  ): Promise<number> {
    const chunks = this.chunker.chunkDocument(
      params.title,
      params.contentMarkdown,
    );
    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => `${c.title}\n${c.content}`),
    );

    const writeFn = async (tx: DrizzleDb): Promise<number> => {
      await tx
        .delete(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.organizationId, params.organizationId),
            eq(knowledgeChunks.sourceType, 'document'),
            eq(knowledgeChunks.sourceId, params.documentId),
          ),
        );

      if (chunks.length === 0) {
        return 0;
      }

      await tx.insert(knowledgeChunks).values(
        chunks.map((chunk, idx) => ({
          organizationId: params.organizationId,
          projectId: params.projectId,
          sourceType: 'document' as const,
          sourceId: params.documentId,
          chunkIndex: chunk.chunkIndex,
          title: chunk.title,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenCount: chunk.tokenCount,
          embedding: embeddings[idx]!,
        })),
      );

      return chunks.length;
    };

    if (existingTx) {
      return writeFn(existingTx);
    }

    return this.dbService.withTenantContext(
      { organizationId: params.organizationId, userId: params.userId },
      writeFn,
    );
  }

  /**
   * Indexes or re-indexes a Task (`displayId`, `title`, `description`, `status`, `priority`, `labels`)
   * into `knowledge_chunks`.
   */
  async indexTask(
    params: {
      organizationId: string;
      userId: string;
      taskId: string;
      projectId: string;
      displayId: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      labels: string[];
    },
    existingTx?: DrizzleDb,
  ): Promise<number> {
    const fullTitle = `${params.displayId}: ${params.title}`;
    const compositeBody = [
      `Task ${params.displayId} (${params.status}, priority: ${params.priority})`,
      params.labels.length > 0 ? `Labels: ${params.labels.join(', ')}` : '',
      params.title,
      params.description ?? '',
    ]
      .filter((line) => line.trim().length > 0)
      .join('\n\n');

    const chunks = this.chunker.chunkDocument(fullTitle, compositeBody);
    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => `${c.title}\n${c.content}`),
    );

    const writeFn = async (tx: DrizzleDb): Promise<number> => {
      await tx
        .delete(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.organizationId, params.organizationId),
            eq(knowledgeChunks.sourceType, 'task'),
            eq(knowledgeChunks.sourceId, params.taskId),
          ),
        );

      if (chunks.length === 0) {
        return 0;
      }

      await tx.insert(knowledgeChunks).values(
        chunks.map((chunk, idx) => ({
          organizationId: params.organizationId,
          projectId: params.projectId,
          sourceType: 'task' as const,
          sourceId: params.taskId,
          chunkIndex: chunk.chunkIndex,
          title: chunk.title,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenCount: chunk.tokenCount,
          embedding: embeddings[idx]!,
        })),
      );

      return chunks.length;
    };

    if (existingTx) {
      return writeFn(existingTx);
    }

    return this.dbService.withTenantContext(
      { organizationId: params.organizationId, userId: params.userId },
      writeFn,
    );
  }

  async removeSourceChunks(
    organizationId: string,
    userId: string,
    sourceType: KnowledgeSourceType,
    sourceId: string,
    existingTx?: DrizzleDb,
  ): Promise<void> {
    const deleteFn = async (tx: DrizzleDb) => {
      await tx
        .delete(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.organizationId, organizationId),
            eq(knowledgeChunks.sourceType, sourceType),
            eq(knowledgeChunks.sourceId, sourceId),
          ),
        );
    };

    if (existingTx) {
      await deleteFn(existingTx);
      return;
    }

    await this.dbService.withTenantContext(
      { organizationId, userId },
      deleteFn,
    );
  }

  /**
   * Executes tenant-isolated Hybrid Search combining pgvector cosine similarity (70% weight)
   * and PostgreSQL full-text `ts_rank_cd` lexical score (30% weight), filtered by caller RBAC/visibility.
   */
  async hybridSearch(
    tenant: TenantMembershipContext,
    input: HybridSearchRequest,
  ): Promise<HybridSearchResponse> {
    const queryVector = await this.embeddingService.embedText(input.query);
    const vectorLiteral = `[${queryVector.join(',')}]`;

    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx, client) => {
        // Determine which project IDs this caller is permitted to see
        const orgProjects = await tx.query.projects.findMany({
          where: eq(projects.organizationId, tenant.organizationId),
        });

        const accessibleProjectIds = new Set<string>();
        for (const proj of orgProjects) {
          if (proj.archivedAt !== null) {
            continue;
          }
          if (tenant.role === 'owner' || tenant.role === 'admin') {
            accessibleProjectIds.add(proj.id);
          } else if (tenant.role === 'guest') {
            if (tenant.guestProjectIds.includes(proj.id)) {
              accessibleProjectIds.add(proj.id);
            }
          } else {
            // 'member'
            if (
              proj.visibility === 'organization' ||
              proj.createdByUserId === tenant.userId
            ) {
              accessibleProjectIds.add(proj.id);
            }
          }
        }

        // If caller filtered by a specific projectId they cannot access, return empty results immediately
        if (input.projectId && !accessibleProjectIds.has(input.projectId)) {
          return { query: input.query, results: [] };
        }

        const sqlQuery = `
          SELECT
            kc.id AS chunk_id,
            kc.source_type,
            kc.source_id,
            kc.project_id,
            kc.chunk_index,
            kc.title,
            kc.content,
            GREATEST(0, 1 - (kc.embedding <=> $1::vector)) AS semantic_score,
            ts_rank_cd(kc.search_tsv, websearch_to_tsquery('english', $2)) AS lexical_score,
            (
              0.70 * GREATEST(0, 1 - (kc.embedding <=> $1::vector)) +
              0.30 * LEAST(1.0, ts_rank_cd(kc.search_tsv, websearch_to_tsquery('english', $2)))
            ) AS hybrid_score
          FROM knowledge_chunks kc
          WHERE kc.organization_id = $3::uuid
            AND kc.source_type = ANY($4::text[])
            AND ($5::uuid IS NULL OR kc.project_id = $5::uuid)
          ORDER BY hybrid_score DESC, semantic_score DESC
          LIMIT $6;
        `;

        const fetchLimit = Math.min(input.limit * 3, 60);
        const res = await client.query<RawHybridRow>(sqlQuery, [
          vectorLiteral,
          input.query,
          tenant.organizationId,
          input.sourceTypes,
          input.projectId ?? null,
          fetchLimit,
        ]);

        const filtered: KnowledgeSearchResultItem[] = [];
        for (const row of res.rows) {
          if (row.project_id === null) {
            if (tenant.role === 'guest') {
              continue;
            }
          } else if (!accessibleProjectIds.has(row.project_id)) {
            continue;
          }

          filtered.push({
            chunkId: row.chunk_id,
            sourceType: row.source_type,
            sourceId: row.source_id,
            projectId: row.project_id,
            chunkIndex: row.chunk_index,
            title: row.title,
            content: row.content,
            semanticScore: Number(Number(row.semantic_score).toFixed(4)),
            lexicalScore: Number(Number(row.lexical_score).toFixed(4)),
            hybridScore: Number(Number(row.hybrid_score).toFixed(4)),
          });

          if (filtered.length >= input.limit) {
            break;
          }
        }

        return {
          query: input.query,
          results: filtered,
        };
      },
    );
  }

  /**
   * Re-indexes all non-archived documents and tasks in the organization.
   */
  async reindexOrganization(
    tenant: TenantMembershipContext,
  ): Promise<{ indexedDocuments: number; indexedTasks: number; totalChunks: number }> {
    const { docRows, taskRows } = await this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        const [docs, tsks] = await Promise.all([
          tx.query.documents.findMany({
            where: eq(documents.organizationId, tenant.organizationId),
          }),
          tx.query.tasks.findMany({
            where: eq(tasks.organizationId, tenant.organizationId),
          }),
        ]);
        return {
          docRows: docs.filter((d) => d.archivedAt === null),
          taskRows: tsks,
        };
      },
    );

    let totalChunks = 0;
    for (const doc of docRows) {
      totalChunks += await this.indexDocument({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        documentId: doc.id,
        projectId: doc.projectId,
        title: doc.title,
        contentMarkdown: doc.contentMarkdown,
      });
    }

    for (const task of taskRows) {
      totalChunks += await this.indexTask({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        taskId: task.id,
        projectId: task.projectId,
        displayId: task.displayId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        labels: task.labels ?? [],
      });
    }

    return {
      indexedDocuments: docRows.length,
      indexedTasks: taskRows.length,
      totalChunks,
    };
  }
}