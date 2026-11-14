import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_ADMIN_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32)
    .default('dev_only_jwt_access_secret_must_be_32_chars_long'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 minutes
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  EMAIL_FROM: z.string().email().default('noreply@teamloom.local'),
  GEMINI_API_KEY: z.string().optional(),
  LLM_DEFAULT_MODEL: z.string().default('gemini-2.5-flash'),
  LLM_EMBEDDING_MODEL: z.string().default('text-embedding-004'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${formatted}`);
  }
  return parsed.data;
}