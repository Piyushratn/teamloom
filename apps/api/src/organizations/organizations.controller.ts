import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptOrganizationInviteRequestSchema,
  CreateOrganizationRequestSchema,
  InviteOrganizationMemberRequestSchema,
  TransferOwnershipRequestSchema,
  UpdateMemberRoleRequestSchema,
  UpdateOrganizationAiSettingsRequestSchema,
  type AcceptOrganizationInviteRequest,
  type AuditLogEntry,
  type CreateOrganizationRequest,
  type InviteOrganizationMemberRequest,
  type OrganizationRole,
  type OrganizationSummary,
  type TransferOwnershipRequest,
  type UpdateMemberRoleRequest,
  type UpdateOrganizationAiSettingsRequest,
} from '@teamloom/contracts';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import {
  CurrentUser,
  type AuthenticatedPrincipal,
} from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrgPermissionGuard } from './org-permission.guard';
import {
  OrganizationsService,
  type OrganizationInviteDetails,
  type OrganizationMemberDetails,
} from './organizations.service';
import {
  CurrentTenant,
  RequirePermission,
  type TenantMembershipContext,
} from './require-permission.decorator';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(
    @Inject(OrganizationsService)
    private readonly orgsService: OrganizationsService,
    @Inject(AuditLogService)
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrganization(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(CreateOrganizationRequestSchema))
    body: CreateOrganizationRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<OrganizationSummary> {
    return this.orgsService.createOrganization(
      principal.userId,
      body,
      this.extractMeta(req),
    );
  }

  @Get()
  async listMyOrganizations(
    @CurrentUser() principal: AuthenticatedPrincipal,
  ): Promise<{ organizations: OrganizationSummary[] }> {
    const organizations = await this.orgsService.listUserOrganizations(
      principal.userId,
    );
    return { organizations };
  }

  @Post('invites/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvite(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(AcceptOrganizationInviteRequestSchema))
    body: AcceptOrganizationInviteRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<OrganizationSummary> {
    return this.orgsService.acceptInvite(
      principal.userId,
      principal.email,
      body,
      this.extractMeta(req),
    );
  }

  @Get(':orgId')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('org:read')
  async getOrganization(
    @CurrentTenant() tenant: TenantMembershipContext,
  ): Promise<OrganizationSummary> {
    return this.orgsService.getOrganizationSummary(
      tenant.organizationId,
      tenant.userId,
      tenant.role,
    );
  }

  @Patch(':orgId/ai-settings')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('ai:manage_settings')
  async updateAiSettings(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(UpdateOrganizationAiSettingsRequestSchema))
    body: UpdateOrganizationAiSettingsRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<OrganizationSummary> {
    return this.orgsService.updateAiSettings(
      tenant.organizationId,
      tenant.userId,
      tenant.role,
      body,
      this.extractMeta(req),
    );
  }

  @Get(':orgId/members')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('member:read')
  async listMembers(
    @CurrentTenant() tenant: TenantMembershipContext,
  ): Promise<{ members: OrganizationMemberDetails[] }> {
    const members = await this.orgsService.listMembers(
      tenant.organizationId,
      tenant.userId,
    );
    return { members };
  }

  @Post(':orgId/invites')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('member:invite')
  async inviteMember(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(InviteOrganizationMemberRequestSchema))
    body: InviteOrganizationMemberRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<OrganizationInviteDetails> {
    return this.orgsService.inviteMember(
      tenant.organizationId,
      tenant.userId,
      body,
      this.extractMeta(req),
    );
  }

  @Delete(':orgId/invites/:inviteId')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('member:invite')
  async revokeInvite(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ revoked: true }> {
    return this.orgsService.revokeInvite(
      tenant.organizationId,
      tenant.userId,
      inviteId,
      this.extractMeta(req),
    );
  }

  @Patch(':orgId/members/:targetUserId/role')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('member:update_role')
  async updateMemberRole(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('targetUserId', new ParseUUIDPipe()) targetUserId: string,
    @Body(new ZodValidationPipe(UpdateMemberRoleRequestSchema))
    body: UpdateMemberRoleRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ updated: true; role: OrganizationRole }> {
    return this.orgsService.updateMemberRole(
      tenant.organizationId,
      tenant.userId,
      targetUserId,
      body,
      this.extractMeta(req),
    );
  }

  @Delete(':orgId/members/:targetUserId')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('member:remove')
  async removeMember(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('targetUserId', new ParseUUIDPipe()) targetUserId: string,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ removed: true }> {
    return this.orgsService.removeMember(
      tenant.organizationId,
      tenant.userId,
      targetUserId,
      this.extractMeta(req),
    );
  }

  @Post(':orgId/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('org:transfer_ownership')
  async transferOwnership(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(TransferOwnershipRequestSchema))
    body: TransferOwnershipRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ transferred: true; newOwnerUserId: string }> {
    return this.orgsService.transferOwnership(
      tenant.organizationId,
      tenant.userId,
      body,
      this.extractMeta(req),
    );
  }

  @Get(':orgId/audit-logs')
  @UseGuards(OrgPermissionGuard)
  @RequirePermission('audit:read')
  async listAuditLogs(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Query('limit') rawLimit?: string,
  ): Promise<{ auditLogs: AuditLogEntry[] }> {
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
    const limit = Number.isNaN(parsedLimit) ? 50 : parsedLimit;
    const auditLogs = await this.auditLogService.listForOrganization(
      tenant.organizationId,
      tenant.userId,
      limit,
    );
    return { auditLogs };
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