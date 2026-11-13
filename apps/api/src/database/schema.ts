import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tracks applied hand-written SQL migrations.
 */
export const schemaMigrations = pgTable('_schema_migrations', {
  id: serial('id').primaryKey(),
  filename: text('filename').notNull().unique(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
});