import type { OrganizationRole } from '@teamloom/contracts';

export type PermissionAction =
  | 'org:read'
  | 'org:update'
  | 'org:transfer_ownership'
  | 'member:read'
  | 'member:invite'
  | 'member:update_role'
  | 'member:remove'
  | 'audit:read'
  | 'ai:manage_settings'
  | 'ai:approve_actions'
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'project:delete'
  | 'task:create'
  | 'task:read'
  | 'task:update'
  | 'task:delete'
  | 'comment:create'
  | 'document:create'
  | 'document:read'
  | 'document:update'
  | 'document:delete';

export const ROLE_PERMISSION_MATRIX: Record<
  OrganizationRole,
  readonly PermissionAction[]
> = {
  owner: [
    'org:read',
    'org:update',
    'org:transfer_ownership',
    'member:read',
    'member:invite',
    'member:update_role',
    'member:remove',
    'audit:read',
    'ai:manage_settings',
    'ai:approve_actions',
    'project:create',
    'project:read',
    'project:update',
    'project:delete',
    'task:create',
    'task:read',
    'task:update',
    'task:delete',
    'comment:create',
    'document:create',
    'document:read',
    'document:update',
    'document:delete',
  ],
  admin: [
    'org:read',
    'org:update',
    'member:read',
    'member:invite',
    'member:update_role',
    'member:remove',
    'audit:read',
    'ai:manage_settings',
    'ai:approve_actions',
    'project:create',
    'project:read',
    'project:update',
    'project:delete',
    'task:create',
    'task:read',
    'task:update',
    'task:delete',
    'comment:create',
    'document:create',
    'document:read',
    'document:update',
    'document:delete',
  ],
  member: [
    'org:read',
    'member:read',
    'ai:approve_actions',
    'project:create',
    'project:read',
    'project:update',
    'task:create',
    'task:read',
    'task:update',
    'task:delete',
    'comment:create',
    'document:create',
    'document:read',
    'document:update',
  ],
  guest: [
    'org:read',
    'project:read',
    'task:read',
    'task:update',
    'comment:create',
    'document:read',
  ],
};

export function roleHasPermission(
  role: OrganizationRole,
  permission: PermissionAction,
): boolean {
  return ROLE_PERMISSION_MATRIX[role].includes(permission);
}

/**
 * Guests are restricted to specific allowed projects within the organization.
 * Owners, admins, and members have organization-wide project visibility unless private.
 */
export function canAccessProjectInOrg(
  role: OrganizationRole,
  guestProjectIds: readonly string[],
  projectId: string,
): boolean {
  if (role === 'guest') {
    return guestProjectIds.includes(projectId);
  }
  return true;
}