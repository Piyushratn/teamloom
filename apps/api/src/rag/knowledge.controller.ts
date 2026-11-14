import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  HybridSearchRequestSchema,
  type HybridSearchRequest,
  type HybridSearchResponse,
} from '@teamloom/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrgPermissionGuard } from '../organizations/org-permission.guard';
import {
  CurrentTenant,
  RequirePermission,
  type TenantMembershipContext,
} from '../organizations/require-permission.decorator';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';

@Controller('organizations/:orgId/knowledge')
@UseGuards(JwtAuthGuard, OrgPermissionGuard)
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeRetrievalService)
    private readonly retrievalService: KnowledgeRetrievalService,
  ) {}

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('document:read')
  async search(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(HybridSearchRequestSchema))
    body: HybridSearchRequest,
  ): Promise<HybridSearchResponse> {
    return this.retrievalService.hybridSearch(tenant, body);
  }

  @Post('reindex')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai:manage_settings')
  async reindex(
    @CurrentTenant() tenant: TenantMembershipContext,
  ): Promise<{
    indexedDocuments: number;
    indexedTasks: number;
    totalChunks: number;
  }> {
    return this.retrievalService.reindexOrganization(tenant);
  }
}