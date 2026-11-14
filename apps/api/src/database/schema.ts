import {
  boolean,
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

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