import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'forks', maxWorkers: 1, fileParallelism: false, setupFiles: ['test/setup.ts'], reporters: process.env.CI ? ['default', './test/ci-progress-reporter.cjs'] : ['default'] } });
