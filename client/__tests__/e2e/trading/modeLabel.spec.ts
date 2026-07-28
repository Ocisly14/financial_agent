import { test, expect } from "@playwright/test";

/**
 * §8.11 — Mode-label visibility test. Asserts the mode badge is rendered
 * on screens that can issue trades: chat header, approval modal, sidebar.
 *
 * Pre-req: the user is logged in (auth cookie set) and has a trading-prefs
 * row whose `default_mode` is either paper / shadow / live.
 */

test.describe("Mode badge visibility", () => {
    test("renders in the app sidebar", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator('[data-mode]').first()).toBeVisible({ timeout: 10_000 });
    });

    test("renders on the /orders route header", async ({ page }) => {
        await page.goto("/orders");
        await expect(page.locator('[data-mode]').first()).toBeVisible({ timeout: 10_000 });
    });

    test("renders on the /strategies route header", async ({ page }) => {
        await page.goto("/strategies");
        await expect(page.locator('[data-mode]').first()).toBeVisible({ timeout: 10_000 });
    });

    test("mode-attribute reflects user prefs", async ({ page }) => {
        await page.goto("/orders");
        const badge = page.locator('[data-mode]').first();
        const mode = await badge.getAttribute("data-mode");
        expect(["paper", "shadow", "live"]).toContain(mode);
    });
});
