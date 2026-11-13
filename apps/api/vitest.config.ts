import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@teamloom/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
    },
  },
});