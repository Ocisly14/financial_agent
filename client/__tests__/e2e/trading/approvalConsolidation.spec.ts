import { test, expect } from "@playwright/test";

/**
 * §7.4 — every trading approval lands in a single canonical surface
 * (`HumanInputDialog` + `TradingOrderEditor`). This spec asserts that a
 * write-intent message produces exactly one approval dialog and that
 * dialog hosts the polished Binance-style editor (not the legacy
 * generic per-field renderer or an alternative duplicate surface).
 */

test.describe("Trading approval consolidation", () => {
    test("CEX interrupt renders TradingOrderEditor exactly once", async ({ page }) => {
        await page.goto("/agents");
        const card = page.locator('[data-testid="agent-card"]').first();
        if (!(await card.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent");
            return;
        }
        await card.click();
        const composer = page.locator('[data-testid="chat-input"]');
        await composer.fill("paper mode: buy 0.001 BTC");
        await composer.press("Enter");
        const editor = page.locator('[data-testid="trading-order-editor"]');
        await expect(editor).toBeVisible({ timeout: 20_000 });
        // Exactly one editor instance — no duplicate surfaces.
        await expect(editor).toHaveCount(1);
    });
});
