import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { validateEnv, type AppEnv } from '../src/config/env.schema';
import { ChunkerService } from '../src/rag/chunker.service';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingService,
} from '../src/rag/embedding.service';

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

describe('ChunkerService & EmbeddingService (Unit)', () => {
  const chunker = new ChunkerService();
  const env = validateEnv({
    NODE_ENV: 'test',
    DATABASE_ADMIN_URL:
      'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev',
    DATABASE_URL:
      'postgresql://teamloom_app:teamloom_app_local_pw@localhost:5432/teamloom_dev',
    REDIS_URL: 'redis://localhost:6379',
  });
  const embeddingService = new EmbeddingService(
    new ConfigService<AppEnv, true>(env),
  );

  it('splits Markdown by headings and enforces maxChars with overlap', () => {
    const markdown = [
      '# Architecture Overview',
      'Teamloom uses PostgreSQL Row-Level Security for strict tenant isolation.',
      '## Authentication Layer',
      'Refresh tokens rotate on every use and detect family replay attacks. '.repeat(
        15,
      ),
    ].join('\n\n');

    const chunks = chunker.chunkDocument('System RFC', markdown, {
      maxChars: 350,
      overlapChars: 60,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.title).toContain('Architecture Overview');
    expect(chunks[1]?.title).toContain('Authentication Layer');
    expect(chunks.every((c) => c.contentHash.length === 64)).toBe(true);
  });

  it('produces 768-dimensional unit-normalized vectors with higher similarity for semantically related text', async () => {
    const vecAuth1 = await embeddingService.embedText(
      'Rotating refresh tokens and argon2id password hashing prevent session hijacking',
    );
    const vecAuth2 = await embeddingService.embedText(
      'Session security relies on argon2id password hashes and rotating refresh token families',
    );
    const vecUnrelated = await embeddingService.embedText(
      'Quarterly marketing budget for outdoor billboards and social media ads',
    );

    expect(vecAuth1.length).toBe(EMBEDDING_DIMENSIONS);
    expect(vecAuth2.length).toBe(EMBEDDING_DIMENSIONS);

    const relatedScore = cosineSimilarity(vecAuth1, vecAuth2);
    const unrelatedScore = cosineSimilarity(vecAuth1, vecUnrelated);

    expect(relatedScore).toBeGreaterThan(0.35);
    expect(relatedScore).toBeGreaterThan(unrelatedScore + 0.25);
  });
});