import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3300);

export default defineConfig({
  testDir: '.',
  outputDir: '.results',
  reporter: [['list'], ['html', { outputFolder: '.report', open: 'never' }]],
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  use: { baseURL: `http://localhost:${port}`, locale: 'nl-NL', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node e2e/start-server.ts',
    cwd: '..',
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
});
