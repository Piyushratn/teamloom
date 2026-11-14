import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OrganizationRole } from '@teamloom/contracts';

/**
 * Tracks applied hand-written SQL migrations.
 */
export const schemaMigrations = pgTable('_schema_migrations', {
  id: serial('id').primaryKey(),
  filename: text('filename').notNull().unique(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Users table (startup-grade authentication with email verification & optional TOTP 2FA).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabled: boolean('totp_enabled').default(false).notNull(),
    totpRecoveryCodesHashes: jsonb('totp_recovery_codes_hashes')
      .$type<string[]>()
      .default([])
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_users_email').on(table.email)],
);

/**
 * Active and rotated refresh token sessions with family-based reuse detection.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    replacedBySessionId: uuid('replaced_by_session_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_auth_sessions_user_id').on(table.userId),
    index('idx_auth_sessions_family_id').on(table.familyId),
  ],
);

/**
 * Single-use expiring tokens for email verification and password reset.
 */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose')
      .$type<'email_verification' | 'password_reset'>()
      .notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_verification_tokens_user_purpose').on(table.userId, table.purpose),
  ],
);

/**
 * Multi-tenant Organizations with AI budget and kill-switch controls.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    aiEnabled: boolean('ai_enabled').default(true).notNull(),
    aiKillSwitch: boolean('ai_kill_switch').default(false).notNull(),
    monthlyAiBudgetUsdCents: integer('monthly_ai_budget_usd_cents')
      .default(1000)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_organizations_slug').on(table.slug),
    index('idx_organizations_owner_id').on(table.ownerId),
  ],
);

/**
 * Organization Memberships (RLS-protected).
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<OrganizationRole>().notNull(),
    guestProjectIds: jsonb('guest_project_ids')
      .$type<string[]>()
      .default([])
      .notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('organization_members_org_user_unique').on(
      table.organizationId,
      table.userId,
    ),
    index('idx_org_members_org_id').on(table.organizationId),
    index('idx_org_members_user_id').on(table.userId),
  ],
);

/**
 * Expiring Email Invitations to an Organization (RLS-protected).
 */
export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role')
      .$type<Exclude<OrganizationRole, 'owner'>>()
      .notNull(),
    guestProjectIds: jsonb('guest_project_ids')
      .$type<string[]>()
      .default([])
      .notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_org_invites_org_id').on(table.organizationId),
    index('idx_org_invites_token_hash').on(table.tokenHash),
  ],
);

/**
 * Append-only security & AI agent audit log (RLS-protected + immutable trigger).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorType: text('actor_type')
      .$type<'user' | 'agent' | 'system'>()
      .notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_audit_logs_org_created').on(table.organizationId, table.createdAt),
    index('idx_audit_logs_org_action').on(table.organizationId, table.action),
  ],
);