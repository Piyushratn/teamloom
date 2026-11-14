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

/**
 * Auth & Account Schemas (Stage 2)
 */
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

export const SignUpRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: PasswordSchema,
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100),
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(1, 'Password is required').max(128),
  totpCode: z.string().trim().min(6).max(16).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const VerifyEmailRequestSchema = z.object({
  token: z.string().trim().min(32).max(256),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().trim().min(32).max(256),
  newPassword: PasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().trim().min(32).max(512),
});
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;

export const TotpVerifySetupRequestSchema = z.object({
  code: z.string().trim().length(6, 'TOTP code must be 6 digits'),
});
export type TotpVerifySetupRequest = z.infer<typeof TotpVerifySetupRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
  emailVerifiedAt: z.string().datetime().nullable(),
  totpEnabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthTokensResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
  user: AuthUserSchema,
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponseSchema>;

export const ActiveSessionSchema = z.object({
  id: z.string().uuid(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  isCurrent: z.boolean(),
});
export type ActiveSession = z.infer<typeof ActiveSessionSchema>;