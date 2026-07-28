import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    // CI has no hardware GPU. Chromium's SwiftShader ANGLE path still exposes
    // WebGL2, which the polygon-shapes scenario probes before compiling the
    // FlatPolygonLayer shader.
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] },
  },
  webServer: [
    {
      command: 'pnpm test:server',
      port: 38473,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm exec vite preview --config vite.config.ts',
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
