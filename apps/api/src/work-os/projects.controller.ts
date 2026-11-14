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
  CreateProjectRequestSchema,
  UpdateProjectRequestSchema,
  type CreateProjectRequest,
  type Project,
  type UpdateProjectRequest,
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
import { ProjectsService } from './projects.service';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('organizations/:orgId/projects')
@UseGuards(JwtAuthGuard, OrgPermissionGuard)
export class ProjectsController {
  constructor(
    @Inject(ProjectsService)
    private readonly projectsService: ProjectsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('project:create')
  async createProject(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(CreateProjectRequestSchema))
    body: CreateProjectRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Project> {
    return this.projectsService.createProject(
      tenant,
      body,
      this.extractMeta(req),
    );
  }

  @Get()
  @RequirePermission('project:read')
  async listProjects(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<{ projects: Project[] }> {
    const projects = await this.projectsService.listProjects(
      tenant,
      includeArchived === 'true',
    );
    return { projects };
  }

  @Get(':projectId')
  @RequirePermission('project:read')
  async getProject(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ): Promise<Project> {
    return this.projectsService.getProjectById(tenant, projectId);
  }

  @Patch(':projectId')
  @RequirePermission('project:update')
  async updateProject(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(UpdateProjectRequestSchema))
    body: UpdateProjectRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Project> {
    return this.projectsService.updateProject(
      tenant,
      projectId,
      body,
      this.extractMeta(req),
    );
  }

  @Delete(':projectId')
  @RequirePermission('project:delete')
  async deleteProject(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ deleted: true }> {
    return this.projectsService.deleteProject(
      tenant,
      projectId,
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