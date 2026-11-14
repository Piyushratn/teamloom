import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.schema';

export const EMBEDDING_DIMENSIONS = 768;

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly nodeEnv: string;

  constructor(@Inject(ConfigService) config: ConfigService<AppEnv, true>) {
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.model = config.get('LLM_EMBEDDING_MODEL', { infer: true });
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
  }

  /**
   * Produces a 768-dimensional unit-normalized embedding vector.
   * Uses Google Gemini `text-embedding-004` when a real GEMINI_API_KEY is configured in non-test mode,
   * and falls back to deterministic 768-d locality-sensitive feature hashing in test/offline mode.
   */
  async embedText(text: string): Promise<number[]> {
    const useLiveGemini =
      this.nodeEnv !== 'test' &&
      Boolean(this.apiKey) &&
      this.apiKey !== 'your_gemini_api_key_here';

    if (useLiveGemini) {
      try {
        return await this.callGeminiEmbeddingApi(text);
      } catch (err) {
        this.logger.warn(
          `Gemini embedding API failed (${err instanceof Error ? err.message : 'unknown error'}); falling back to deterministic local embedding`,
        );
      }
    }

    return this.computeDeterministicEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embedText(t)));
  }

  private async callGeminiEmbeddingApi(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini embedContent HTTP ${response.status}`);
    }

    const data = (await response.json()) as GeminiEmbedResponse;
    const values = data.embedding?.values;
    if (!values || values.length !== EMBEDDING_DIMENSIONS) {
      throw new Error('Invalid embedding dimensions returned from Gemini');
    }

    return this.normalizeL2(values);
  }

  /**
   * Deterministic 768-dimensional signed feature-hashing embedding (L2-normalized).
   * Ensures texts sharing words, stems, and bigrams have high cosine similarity in pgvector.
   */
  computeDeterministicEmbedding(text: string): number[] {
    const vector = new Float64Array(EMBEDDING_DIMENSIONS);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    if (tokens.length === 0) {
      vector[0] = 1;
      return Array.from(vector);
    }

    const features: Array<{ term: string; weight: number }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      features.push({ term: `tok:${token}`, weight: 1.0 });

      // Prefix stem feature (captures e.g. "authenticate" <-> "authentication")
      if (token.length >= 5) {
        features.push({ term: `stem:${token.slice(0, 5)}`, weight: 0.75 });
      }

      // Word bigram feature
      if (i + 1 < tokens.length) {
        features.push({
          term: `bi:${token}_${tokens[i + 1]!}`,
          weight: 1.25,
        });
      }
    }

    for (const feat of features) {
      const digest = createHash('md5').update(feat.term).digest();
      const dim1 = digest.readUInt16BE(0) % EMBEDDING_DIMENSIONS;
      const sign1 = (digest[2]! & 1) === 0 ? 1 : -1;
      const dim2 = digest.readUInt16BE(4) % EMBEDDING_DIMENSIONS;
      const sign2 = (digest[6]! & 1) === 0 ? 1 : -1;

      vector[dim1] = (vector[dim1] ?? 0) + sign1 * feat.weight;
      vector[dim2] = (vector[dim2] ?? 0) + sign2 * (feat.weight * 0.5);
    }

    return this.normalizeL2(Array.from(vector));
  }

  private normalizeL2(values: number[]): number[] {
    let sumSq = 0;
    for (const v of values) {
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq);
    if (norm === 0) {
      const fallback = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      fallback[0] = 1;
      return fallback;
    }
    return values.map((v) => Number((v / norm).toFixed(6)));
  }
}