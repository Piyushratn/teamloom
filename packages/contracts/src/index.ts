import { z } from 'zod';

/**
 * Standard API Error Envelope enforced across every endpoint in Teamloom.
 */
export const ApiErrorIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const ApiErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  errorCode: z.string(),
  message: z.string(),
  requestId: z.string(),
  timestamp: z.string().datetime(),
  issues: z.array(ApiErrorIssueSchema).optional(),
});

export type ApiErrorIssue = z.infer<typeof ApiErrorIssueSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/**
 * Health check response contract for API, Postgres (pgvector), and Redis.
 */
export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  timestamp: z.string().datetime(),
  services: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
  }),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * Role hierarchy for Organization RBAC.
 */
export const OrganizationRoleSchema = z.enum(['owner', 'admin', 'member', 'guest']);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;