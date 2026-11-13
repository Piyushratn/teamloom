import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env.schema';

describe('validateEnv', () => {
  it('parses valid environment variables and applies defaults', () => {
    const env = validateEnv({
      DATABASE_ADMIN_URL: 'postgresql://admin:pw@localhost:5432/teamloom_dev',
      DATABASE_URL: 'postgresql://app:pw@localhost:5432/teamloom_dev',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('throws a descriptive error when DATABASE_URL is missing', () => {
    expect(() =>
      validateEnv({
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/DATABASE_URL/);
  });
});