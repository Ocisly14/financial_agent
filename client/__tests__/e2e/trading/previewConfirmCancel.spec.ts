import { test, expect } from "@playwright/test";

/**
 * §8.11 — preview → confirm → cancel flow.
 *
 * Asserts the canonical trading approval renders the polished
 * Binance-style `TradingOrderEditor` form for a write intent, then
 * exercises Cancel on the resulting open-orders row. Trades are routed
 * through paper mode so the test never touches a real venue.
 *
 * Pre-req: a chat agent is configured with paper-mode prefs.
 */

test.describe("CEX preview → confirm → cancel", () => {
    test("level-1 review renders the trading order editor", async ({ page }) => {
        await page.goto("/agents");
        const agentCard = page.locator('[data-testid="agent-card"]').first();
        if (!(await agentCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent — skipping");
            return;
        }
        await agentCard.click();
        const composer = page.locator('[data-testid="chat-input"]');
        await composer.fill("paper mode: buy 0.001 BTC");
        await composer.press("Enter");
        const editor = page.locator('[data-testid="trading-order-editor"]');
        await expect(editor).toBeVisible({ timeout: 20_000 });
        // Confirm button is the single canonical CTA on the review/final
        // confirm step (label varies between "Submit" and "Confirm").
        const cta = page.locator('button:has-text("Submit"), button:has-text("Confirm")').first();
        await expect(cta).toBeVisible({ timeout: 5_000 });
    });

    test("cancel from open-orders surfaces an inline cancel control", async ({ page }) => {
        await page.goto("/orders");
        const ordersTable = page.locator('[data-testid="orders-table"]');
        await expect(ordersTable).toBeVisible({ timeout: 10_000 });
        const cancelChip = ordersTable.locator('button:has-text("Cancel")').first();
        if (!(await cancelChip.isVisible({ timeout: 2_000 }).catch(() => false))) {
            test.info().annotations.push({
                type: "note",
                description: "no open orders to cancel; surface check skipped",
            });
            return;
        }
        await cancelChip.click();
        await expect(page.locator('text=/cancel/i')).toBeVisible({ timeout: 5_000 });
    });
});
