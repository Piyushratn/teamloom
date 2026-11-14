import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/current-user.decorator';
import { DatabaseService } from '../database/database.module';
import { organizationMembers } from '../database/schema';
import {
  canAccessProjectInOrg,
  roleHasPermission,
  type PermissionAction,
} from './permissions.matrix';
import {
  REQUIRED_PERMISSION_KEY,
  type TenantMembershipContext,
} from './require-permission.decorator';

const UuidSchema = z.string().uuid();

interface RequestWithTenant {
  user?: AuthenticatedPrincipal;
  params?: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  tenant?: TenantMembershipContext;
}

@Injectable()
export class OrgPermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException({
        errorCode: 'UNAUTHENTICATED',
        message: 'Authentication is required before checking organization permissions',
      });
    }

    const headerOrgId = request.headers['x-organization-id'];
    const rawOrgId =
      request.params?.orgId ??
      request.params?.organizationId ??
      (Array.isArray(headerOrgId) ? headerOrgId[0] : headerOrgId);

    const parsedOrgId = UuidSchema.safeParse(rawOrgId);
    if (!parsedOrgId.success) {
      throw new BadRequestException({
        errorCode: 'INVALID_ORGANIZATION_ID',
        message: 'A valid organization ID is required in route params or x-organization-id header',
      });
    }

    const organizationId = parsedOrgId.data;

    // Query membership inside RLS tenant context
    const membership = await this.dbService.withTenantContext(
      { organizationId, userId: user.userId },
      async (tx) => {
        return tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, user.userId),
          ),
        });
      },
    );

    if (!membership) {
      throw new ForbiddenException({
        errorCode: 'ORG_ACCESS_DENIED',
        message: 'You do not have access to this organization',
      });
    }

    const requiredPermission =
      this.reflector.getAllAndOverride<PermissionAction | undefined>(
        REQUIRED_PERMISSION_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (
      requiredPermission &&
      !roleHasPermission(membership.role, requiredPermission)
    ) {
      throw new ForbiddenException({
        errorCode: 'INSUFFICIENT_ROLE_PERMISSION',
        message: `Role '${membership.role}' does not have permission '${requiredPermission}'`,
      });
    }

    // If route has a :projectId param and user is a guest, enforce guestProjectIds boundary
    const projectId = request.params?.projectId;
    if (
      projectId &&
      !canAccessProjectInOrg(
        membership.role,
        membership.guestProjectIds ?? [],
        projectId,
      )
    ) {
      throw new ForbiddenException({
        errorCode: 'GUEST_PROJECT_RESTRICTED',
        message: 'Guest account does not have access to this project',
      });
    }

    request.tenant = {
      organizationId,
      userId: user.userId,
      role: membership.role,
      guestProjectIds: membership.guestProjectIds ?? [],
    };

    return true;
  }
}