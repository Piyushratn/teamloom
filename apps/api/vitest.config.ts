import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      DATABASE_ADMIN_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://teamloom_admin:teamloom_admin_local_pw@localhost:5432/teamloom_dev',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://teamloom_app:teamloom_app_local_pw@localhost:5432/teamloom_dev',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
  },
  resolve: {
    alias: {
      '@teamloom/contracts': path.resolve(
        __dirname,
        '../../packages/contracts/src/index.ts',
      ),
    },
  },
});