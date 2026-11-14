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

/**
 * Organizations, Invites, Roles & Audit Log Schemas (Stage 3)
 */
export const OrganizationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Slug must be at least 3 characters')
  .max(48, 'Slug must be at most 48 characters')
  .regex(
    /^[a-z0-9-]+$/,
    'Slug may only contain lowercase letters, numbers, and hyphens',
  );

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().trim().min(2, 'Organization name must be at least 2 characters').max(80),
  slug: OrganizationSlugSchema,
});
export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const InviteOrganizationMemberRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  role: z.enum(['admin', 'member', 'guest']),
  guestProjectIds: z.array(z.string().uuid()).default([]),
});
export type InviteOrganizationMemberRequest = z.infer<
  typeof InviteOrganizationMemberRequestSchema
>;

export const AcceptOrganizationInviteRequestSchema = z.object({
  token: z.string().trim().min(32).max(256),
});
export type AcceptOrganizationInviteRequest = z.infer<
  typeof AcceptOrganizationInviteRequestSchema
>;

export const UpdateMemberRoleRequestSchema = z.object({
  role: z.enum(['admin', 'member', 'guest']),
  guestProjectIds: z.array(z.string().uuid()).optional(),
});
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequestSchema>;

export const TransferOwnershipRequestSchema = z.object({
  newOwnerUserId: z.string().uuid(),
});
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequestSchema>;

export const UpdateOrganizationAiSettingsRequestSchema = z
  .object({
    aiEnabled: z.boolean().optional(),
    aiKillSwitch: z.boolean().optional(),
    monthlyAiBudgetUsdCents: z.number().int().min(0).max(10_000_000).optional(),
  })
  .refine(
    (data) =>
      data.aiEnabled !== undefined ||
      data.aiKillSwitch !== undefined ||
      data.monthlyAiBudgetUsdCents !== undefined,
    { message: 'At least one AI setting field must be provided' },
  );
export type UpdateOrganizationAiSettingsRequest = z.infer<
  typeof UpdateOrganizationAiSettingsRequestSchema
>;

export const OrganizationSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  ownerId: z.string().uuid(),
  myRole: OrganizationRoleSchema,
  aiEnabled: z.boolean(),
  aiKillSwitch: z.boolean(),
  monthlyAiBudgetUsdCents: z.number().int(),
  createdAt: z.string().datetime(),
});
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorType: z.enum(['user', 'agent', 'system']),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/**
 * Core Work OS Schemas: Projects, Tasks, Comments & Documents (Stage 4)
 */
export const ProjectVisibilitySchema = z.enum(['organization', 'private']);
export type ProjectVisibility = z.infer<typeof ProjectVisibilitySchema>;

export const ProjectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Project key must be 2–10 uppercase letters or numbers')
  .max(10, 'Project key must be 2–10 uppercase letters or numbers')
  .regex(/^[A-Z][A-Z0-9]*$/, 'Project key must start with a letter and contain only A-Z and 0-9');

export const CreateProjectRequestSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).optional(),
  visibility: ProjectVisibilitySchema.default('organization'),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  visibility: ProjectVisibilitySchema.optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: ProjectVisibilitySchema,
  taskSequence: z.number().int(),
  createdByUserId: z.string().uuid(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskStatusSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const CreateTaskRequestSchema = z.object({
  title: z.string().trim().min(2).max(240),
  description: z.string().trim().max(10000).optional(),
  status: TaskStatusSchema.default('todo'),
  priority: TaskPrioritySchema.default('medium'),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z.object({
  title: z.string().trim().min(2).max(240).optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  position: z.number().int().min(0).optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const TaskSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  number: z.number().int(),
  displayId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  assigneeUserId: z.string().uuid().nullable(),
  reporterUserId: z.string().uuid(),
  dueDate: z.string().datetime().nullable(),
  labels: z.array(z.string()),
  position: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskCommentRequestSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(5000),
});
export type CreateTaskCommentRequest = z.infer<
  typeof CreateTaskCommentRequestSchema
>;

export const TaskCommentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  authorUserId: z.string().uuid().nullable(),
  authorType: z.enum(['user', 'agent']),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskComment = z.infer<typeof TaskCommentSchema>;

export const CreateDocumentRequestSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(2).max(200),
  contentMarkdown: z.string().max(100_000).default(''),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

export const UpdateDocumentRequestSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  contentMarkdown: z.string().max(100_000).optional(),
  archived: z.boolean().optional(),
});
export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentRequestSchema>;

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  title: z.string(),
  contentMarkdown: z.string(),
  version: z.number().int(),
  createdByUserId: z.string().uuid(),
  updatedByUserId: z.string().uuid(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;