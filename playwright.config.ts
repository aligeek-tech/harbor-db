import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  timeout: 90000,
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
  reporter: 'list',
})
