import { Global, Module } from '@nestjs/common';
import { ChunkerService } from './chunker.service';
import { EmbeddingService } from './embedding.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeController } from './knowledge.controller';

@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [ChunkerService, EmbeddingService, KnowledgeRetrievalService],
  exports: [ChunkerService, EmbeddingService, KnowledgeRetrievalService],
})
export class RagModule {}