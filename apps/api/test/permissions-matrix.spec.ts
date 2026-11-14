import { describe, expect, it } from 'vitest';
import {
  canAccessProjectInOrg,
  ROLE_PERMISSION_MATRIX,
  roleHasPermission,
  type PermissionAction,
} from '../src/organizations/permissions.matrix';

const ALL_PERMISSIONS: PermissionAction[] = [
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
];

describe('RBAC Permission Matrix (owner, admin, member, guest)', () => {
  it('grants owner every permission including org:transfer_ownership', () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(roleHasPermission('owner', perm)).toBe(true);
    }
  });

  it('grants admin all management permissions except org:transfer_ownership', () => {
    expect(roleHasPermission('admin', 'org:transfer_ownership')).toBe(false);
    expect(roleHasPermission('admin', 'member:invite')).toBe(true);
    expect(roleHasPermission('admin', 'audit:read')).toBe(true);
    expect(roleHasPermission('admin', 'ai:manage_settings')).toBe(true);
  });

  it('allows member to work on projects/tasks/AI approvals but blocks member/org/audit admin actions', () => {
    expect(roleHasPermission('member', 'project:create')).toBe(true);
    expect(roleHasPermission('member', 'task:create')).toBe(true);
    expect(roleHasPermission('member', 'ai:approve_actions')).toBe(true);

    expect(roleHasPermission('member', 'member:invite')).toBe(false);
    expect(roleHasPermission('member', 'member:remove')).toBe(false);
    expect(roleHasPermission('member', 'audit:read')).toBe(false);
    expect(roleHasPermission('member', 'ai:manage_settings')).toBe(false);
    expect(roleHasPermission('member', 'project:delete')).toBe(false);
  });

  it('restricts guest to read/comment/task:update and enforces guestProjectIds allowlist', () => {
    expect(ROLE_PERMISSION_MATRIX.guest).toEqual([
      'org:read',
      'project:read',
      'task:read',
      'task:update',
      'comment:create',
      'document:read',
    ]);
    expect(roleHasPermission('guest', 'task:create')).toBe(false);
    expect(roleHasPermission('guest', 'ai:approve_actions')).toBe(false);

    const allowedProject = '11111111-2222-3333-4444-555555555555';
    const forbiddenProject = '99999999-8888-7777-6666-555555555555';

    expect(
      canAccessProjectInOrg('guest', [allowedProject], allowedProject),
    ).toBe(true);
    expect(
      canAccessProjectInOrg('guest', [allowedProject], forbiddenProject),
    ).toBe(false);
    expect(
      canAccessProjectInOrg('member', [], forbiddenProject),
    ).toBe(true);
  });
});