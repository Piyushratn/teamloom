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
  CreateDocumentRequestSchema,
  UpdateDocumentRequestSchema,
  type CreateDocumentRequest,
  type Document,
  type UpdateDocumentRequest,
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
import { DocumentsService } from './documents.service';

interface FastifyRequestWithIp {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('organizations/:orgId/documents')
@UseGuards(JwtAuthGuard, OrgPermissionGuard)
export class DocumentsController {
  constructor(
    @Inject(DocumentsService)
    private readonly documentsService: DocumentsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('document:create')
  async createDocument(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Body(new ZodValidationPipe(CreateDocumentRequestSchema))
    body: CreateDocumentRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Document> {
    return this.documentsService.createDocument(
      tenant,
      body,
      this.extractMeta(req),
    );
  }

  @Get()
  @RequirePermission('document:read')
  async listDocuments(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Query('projectId') projectId?: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<{ documents: Document[] }> {
    const documents = await this.documentsService.listDocuments(
      tenant,
      projectId,
      includeArchived === 'true',
    );
    return { documents };
  }

  @Get(':documentId')
  @RequirePermission('document:read')
  async getDocument(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<Document> {
    return this.documentsService.getDocumentById(tenant, documentId);
  }

  @Patch(':documentId')
  @RequirePermission('document:update')
  async updateDocument(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body(new ZodValidationPipe(UpdateDocumentRequestSchema))
    body: UpdateDocumentRequest,
    @Req() req: FastifyRequestWithIp,
  ): Promise<Document> {
    return this.documentsService.updateDocument(
      tenant,
      documentId,
      body,
      this.extractMeta(req),
    );
  }

  @Delete(':documentId')
  @RequirePermission('document:delete')
  async deleteDocument(
    @CurrentTenant() tenant: TenantMembershipContext,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Req() req: FastifyRequestWithIp,
  ): Promise<{ deleted: true }> {
    return this.documentsService.deleteDocument(
      tenant,
      documentId,
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