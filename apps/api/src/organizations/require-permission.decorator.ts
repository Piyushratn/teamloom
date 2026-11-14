import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import type { OrganizationRole } from '@teamloom/contracts';
import type { PermissionAction } from './permissions.matrix';

export const REQUIRED_PERMISSION_KEY = 'teamloom:required_permission';

export const RequirePermission = (permission: PermissionAction) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

export interface TenantMembershipContext {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  guestProjectIds: string[];
}

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantMembershipContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ tenant: TenantMembershipContext }>();
    return request.tenant;
  },
);