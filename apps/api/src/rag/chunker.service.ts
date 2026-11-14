import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface TextChunk {
  chunkIndex: number;
  title: string;
  content: string;
  contentHash: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

@Injectable()
export class ChunkerService {
  /**
   * Splits Markdown or plain text into overlapping, heading-aware semantic chunks.
   */
  chunkDocument(
    documentTitle: string,
    markdown: string,
    options: ChunkOptions = {},
  ): TextChunk[] {
    const maxChars = options.maxChars ?? 800;
    const overlapChars = options.overlapChars ?? 120;
    const cleanText = markdown.replace(/\r\n/g, '\n').trim();

    if (!cleanText) {
      return [this.buildChunk(0, documentTitle, documentTitle)];
    }

    const lines = cleanText.split('\n');
    const sections: Array<{ heading: string; body: string }> = [];
    let currentHeading = documentTitle;
    let buffer: string[] = [];

    for (const line of lines) {
      const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line.trim());
      if (headingMatch) {
        if (buffer.length > 0) {
          sections.push({
            heading: currentHeading,
            body: buffer.join('\n').trim(),
          });
          buffer = [];
        }
        currentHeading = `${documentTitle} — ${headingMatch[2]!.trim()}`;
      } else {
        buffer.push(line);
      }
    }

    if (buffer.length > 0) {
      sections.push({
        heading: currentHeading,
        body: buffer.join('\n').trim(),
      });
    }

    const chunks: TextChunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
      const text = section.body || section.heading;
      if (text.length <= maxChars) {
        chunks.push(this.buildChunk(chunkIndex++, section.heading, text));
        continue;
      }

      let start = 0;
      while (start < text.length) {
        let end = Math.min(start + maxChars, text.length);
        if (end < text.length) {
          const lastBreak = Math.max(
            text.lastIndexOf('\n\n', end),
            text.lastIndexOf('. ', end),
            text.lastIndexOf(' ', end),
          );
          if (lastBreak > start + Math.floor(maxChars * 0.5)) {
            end = lastBreak + 1;
          }
        }

        const slice = text.slice(start, end).trim();
        if (slice.length > 0) {
          chunks.push(this.buildChunk(chunkIndex++, section.heading, slice));
        }

        if (end >= text.length) {
          break;
        }
        start = Math.max(start + 1, end - overlapChars);
      }
    }

    return chunks.length > 0
      ? chunks
      : [this.buildChunk(0, documentTitle, cleanText)];
  }

  private buildChunk(
    chunkIndex: number,
    title: string,
    content: string,
  ): TextChunk {
    const normalizedContent = content.trim();
    const contentHash = createHash('sha256')
      .update(`${title}\n${normalizedContent}`)
      .digest('hex');

    // Approximate token count (~4 chars per token)
    const tokenCount = Math.max(1, Math.ceil(normalizedContent.length / 4));

    return {
      chunkIndex,
      title,
      content: normalizedContent,
      contentHash,
      tokenCount,
    };
  }
}