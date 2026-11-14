import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_ADMIN_URL: z
    .string()
    .url()
    .refine(
      (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
      'DATABASE_ADMIN_URL must be a valid PostgreSQL connection string',
    ),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
      'DATABASE_URL must be a valid PostgreSQL connection string',
    ),
  REDIS_URL: z
    .string()
    .url()
    .refine(
      (url) => url.startsWith('redis://') || url.startsWith('rediss://'),
      'REDIS_URL must be a valid Redis connection string',
    ),

  JWT_SECRET: z
    .string()
    .min(32)
    .default('dev_only_jwt_secret_minimum_32_characters_long_teamloom'),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32)
    .default('dev_only_jwt_access_secret_min_32_characters_long'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32)
    .default('dev_only_jwt_refresh_secret_min_32_characters_long'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  TOTP_ENCRYPTION_KEY: z
    .string()
    .min(32)
    .default('dev_only_totp_encryption_key_32_chars_minimum!'),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_FROM: z.string().email().default('no-reply@teamloom.local'),
  EMAIL_FROM: z.string().email().default('no-reply@teamloom.local'),

  GEMINI_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gemini-2.5-flash'),
  LLM_CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  LLM_EMBEDDING_MODEL: z.string().default('text-embedding-004'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = EnvSchema.safeParse(config);

  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  return parsed.data;
}