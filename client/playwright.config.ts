import { defineConfig, devices } from "@playwright/test";

/**
 * §8.11 — E2E config for the trading suite. Run locally against staging:
 *
 *   pnpm --filter client test:e2e -- trading/
 *
 * CI invocation is gated to `staging` only (per CLAUDE.md "Staging E2E
 * workflow runs manually only"). Add new specs under `client/__tests__/e2e/`.
 */
export default defineConfig({
    testDir: "./__tests__/e2e",
    timeout: 60_000,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
});
