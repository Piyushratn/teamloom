import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CopilotAskRequestSchema,
  ProposeProjectActionsRequestSchema,
  ReviewProposedActionRequestSchema,
  type AiBudgetSummary,
  type CopilotAskRequest,
  type CopilotAskResponse,
  type ProposedAction,
  type ProposedActionStatus,
  type ProposeProjectActionsRequest,
  type ReviewProposedActionRequest,
} from '@teamloom/contracts';
import type { RequestMetadata } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrgPermissionGuard } from '../organizations/org-permission.guard';
import {
  CurrentTenant,
  RequirePermission,
  type TenantMembershipContext,
} from '../organizations/require-permission.decorator';
import { AiAgentService } from './ai-agent.service';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('organizations/:orgId/ai')
@UseGuards(JwtAuthGuard, OrgPermissionGuard)
export class AiAgentController {
  constructor(
    @Inject(AiAgentService) private readonly aiAgentService: AiAgentService,
  ) {}

  @Get('budget')
  @RequirePermission('org:read')
  async getBudget(
    @CurrentTenant() tenant: TenantMembershipContext,
  ): Promise<AiBudgetSummary> {
    return this.aiAgentService.getBudgetSummary(tenant);
  }

  @Post('copilot/ask')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('document:read')
  async askCopilot(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(CopilotAskRequestSchema))
    body: CopilotAskRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<CopilotAskResponse> {
    return this.aiAgentService.askCopilot(tenant, body, this.extractMeta(req));
  }

  @Post('proposals/generate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('ai:approve_actions')
  async generateProposals(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(ProposeProjectActionsRequestSchema))
    body: ProposeProjectActionsRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ proposals: ProposedAction[]; tokensUsed: number }> {
    return this.aiAgentService.generateProposals(
      tenant,
      body,
      this.extractMeta(req),
    );
  }

  @Get('proposals')
  @RequirePermission('project:read')
  async listProposals(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Query('projectId') projectId?: string,
    @Query('status') status?: ProposedActionStatus,
  ): Promise<{ proposals: ProposedAction[] }> {
    const proposals = await this.aiAgentService.listProposals(tenant, {
      projectId,
      status,
    });
    return { proposals };
  }

  @Post('proposals/:actionId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai:approve_actions')
  async reviewProposal(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('actionId', new ParseUUIDPipe()) actionId: string,
    @Body(new ZodValidationPipe(ReviewProposedActionRequestSchema))
    body: ReviewProposedActionRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<ProposedAction> {
    return this.aiAgentService.reviewProposal(
      tenant,
      actionId,
      body,
      this.extractMeta(req),
    );
  }

  private extractMeta(req: FastifyRequestWithIp): RequestMetadata {
    const rawUa = req.headers['user-agent'];
    const userAgent =
      (Array.isArray(rawUa) ? rawUa[0] : rawUa) ?? 'unknown-agent';
    return {
      ipAddress: req.ip ?? '127.0.0.1',
      userAgent,
    };
  }
}