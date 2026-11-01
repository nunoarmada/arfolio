import { defineConfig, devices } from '@playwright/test';

const ip = (last: number) => ({ extraHTTPHeaders: { 'x-real-ip': `127.0.0.${last}` } });

// Started by e2e/run.ts, which provides E2E_BASE_URL and a migrated database.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    locale: 'pt-PT',
    // The trusted reverse proxy (Traefik) sets this in production; rate limiting keys on it.
    // Later projects get their own address (ip() above) so sign-ins from consecutive projects
    // never share the 5-per-minute sign-in window.
    extraHTTPHeaders: { 'x-real-ip': '127.0.0.1' },
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    // Creates the household, the owner and the TOTP secret everything else builds on.
    { name: 'foundation', testMatch: /foundation\.spec\.ts/ },
    { name: 'phase1', testMatch: /phase1\.spec\.ts/, dependencies: ['foundation'], use: ip(2) },
    // Connections, notifications and AI suggestions, against the fake providers from run.ts.
    { name: 'phase2', testMatch: /phase2\.spec\.ts/, dependencies: ['phase1'], use: ip(3) },
    // Axe on the new screens; runs after phase2 so the pages have data.
    { name: 'a11y', testMatch: /a11y\.spec\.ts/, dependencies: ['phase2'], use: ip(4) },
    // Budget, transfer plan, subscriptions and budget import (with their own axe checks).
    { name: 'phase3', testMatch: /phase3\.spec\.ts/, dependencies: ['phase2'], use: ip(5) },
    // Asset details, the AI valuation switch and estimate display. Only needs the owner; names its
    // asset apart from phase4's and removes it at the end.
    {
      name: 'ai-valuation',
      testMatch: /ai-valuation\.spec\.ts/,
      dependencies: ['foundation'],
      use: ip(12),
    },
    // Selling, writing off, settling and deleting assets and credits, and the credits nested under an
    // asset. Needs the owner and the household back on EUR (phase1); names its records apart from
    // phase4's and deletes them at the end.
    {
      name: 'asset-disposal',
      testMatch: /asset-disposal\.spec\.ts/,
      dependencies: ['phase1'],
      use: ip(13),
    },
    // Net worth: assets, liabilities with a schedule, the history chart, Home card (with axe).
    { name: 'phase4', testMatch: /phase4\.spec\.ts/, dependencies: ['phase3'], use: ip(6) },
    // Dashboards: the home blocks (and, later, Análises and push settings). Needs the budget and
    // subscriptions the earlier phases leave behind, and seeds the rest itself, so it does not
    // depend on phase4.
    { name: 'phase5', testMatch: /phase5\.spec\.ts/, dependencies: ['phase3'], use: ip(7) },
    // Integrations (MCP): personal access tokens, connected OAuth apps, the consent page. Seeds
    // what it needs and puts it back, so like phase5 it only needs the household from phase3.
    { name: 'phase6', testMatch: /phase6\.spec\.ts/, dependencies: ['phase3'], use: ip(8) },
    // AI reports and anomalies in Análises: seeds ai_report rows directly (no model is called) and
    // puts everything back, so like phase6 it only needs the household from phase3.
    { name: 'phase7', testMatch: /phase7\.spec\.ts/, dependencies: ['phase3'], use: ip(9) },
    // Merchant logos, friendly names and the details card. Seeds what it needs and removes it.
    {
      name: 'tx-details',
      testMatch: /tx-details\.spec\.ts/,
      dependencies: ['phase1'],
      use: ip(11),
    },
    // Apply a rule to existing movements (preview, undo) and the investment holdings on an account
    // page. Seeds what it needs and removes it, so it only needs the household, the owner and the
    // viewer that phase1 leaves behind.
    {
      name: 'rules-holdings',
      testMatch: /rules-holdings\.spec\.ts/,
      dependencies: ['phase1'],
      use: ip(10),
    },
    // Settings > Services: the owner saves the AI key from the UI (on the instance without a key
    // in its environment), the section is hidden from other roles, and what it stores is put back.
    {
      name: 'services',
      testMatch: /services\.spec\.ts/,
      dependencies: ['phase1'],
      use: ip(14),
    },
    { name: 'privacy', testMatch: /privacy\.spec\.ts/, dependencies: ['phase1'], use: ip(15) },
  ],
});
