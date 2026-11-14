import { Global, Module } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { OrgPermissionGuard } from './org-permission.guard';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Global()
@Module({
  controllers: [OrganizationsController],
  providers: [AuditLogService, OrganizationsService, OrgPermissionGuard],
  exports: [AuditLogService, OrganizationsService, OrgPermissionGuard],
})
export class OrganizationsModule {}