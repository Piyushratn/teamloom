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
  CreateTaskCommentRequestSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  type CreateTaskCommentRequest,
  type CreateTaskRequest,
  type Task,
  type TaskComment,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskRequest,
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
import { TasksService } from './tasks.service';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('organizations/:orgId/projects/:projectId/tasks')
@UseGuards(JwtAuthGuard, OrgPermissionGuard)
export class TasksController {
  constructor(
    @Inject(TasksService) private readonly tasksService: TasksService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('task:create')
  async createTask(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new ZodValidationPipe(CreateTaskRequestSchema))
    body: CreateTaskRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Task> {
    return this.tasksService.createTask(
      tenant,
      projectId,
      body,
      this.extractMeta(req),
    );
  }

  @Get()
  @RequirePermission('task:read')
  async listTasks(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('status') status?: TaskStatus,
    @Query('priority') priority?: TaskPriority,
    @Query('assigneeUserId') assigneeUserId?: string,
  ): Promise<{ tasks: Task[] }> {
    const tasks = await this.tasksService.listTasks(tenant, projectId, {
      status,
      priority,
      assigneeUserId,
    });
    return { tasks };
  }

  @Get(':taskId')
  @RequirePermission('task:read')
  async getTask(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<Task> {
    return this.tasksService.getTaskById(tenant, projectId, taskId);
  }

  @Patch(':taskId')
  @RequirePermission('task:update')
  async updateTask(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodValidationPipe(UpdateTaskRequestSchema))
    body: UpdateTaskRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Task> {
    return this.tasksService.updateTask(
      tenant,
      projectId,
      taskId,
      body,
      this.extractMeta(req),
    );
  }

  @Delete(':taskId')
  @RequirePermission('task:delete')
  async deleteTask(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ deleted: true }> {
    return this.tasksService.deleteTask(
      tenant,
      projectId,
      taskId,
      this.extractMeta(req),
    );
  }

  @Post(':taskId/comments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('comment:create')
  async addComment(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new ZodValidationPipe(CreateTaskCommentRequestSchema))
    body: CreateTaskCommentRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<TaskComment> {
    return this.tasksService.addComment(
      tenant,
      projectId,
      taskId,
      body,
      this.extractMeta(req),
    );
  }

  @Get(':taskId/comments')
  @RequirePermission('task:read')
  async listComments(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ): Promise<{ comments: TaskComment[] }> {
    const comments = await this.tasksService.listComments(
      tenant,
      projectId,
      taskId,
    );
    return { comments };
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