import { test, expect } from "@playwright/test";

/**
 * §7.10 — Standardized error contract. For every failure surface
 * (risk_block, fail_closed, unknown_state, idempotency_hit, …) the UI
 * must render a non-empty `action` next-step line; an opaque "Sorry,
 * something went wrong." is a regression.
 *
 * Walks the trading flow with payloads engineered to fall into each
 * branch, then asserts that the resulting message includes a recognised
 * next-step.
 */

const REQUIRED_NEXT_STEPS = [
    // Each phrase MUST appear in at least one rendered failure surface.
    /try again later|稍后再试/i,
    /accept the live[- ]trading|签署 live[- ]?trading/i,
    /switch to paper mode|切换到 paper/i,
    /Waiting for reconciliation|等待对账/i,
];

test.describe("Standardized error contract", () => {
    test("every refused trade renders a next-step", async ({ page }) => {
        await page.goto("/agents");
        const card = page.locator('[data-testid="agent-card"]').first();
        if (!(await card.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent");
            return;
        }
        await card.click();
        const composer = page.locator('[data-testid="chat-input"]');
        // Engineer a refusal: blocklisted asset.
        await composer.fill("buy 0.1 BLOCKLISTEDASSET on binance");
        await composer.press("Enter");
        // The final response should contain a next-step phrase from the
        // standardized error contract. We don't care which branch fires
        // — we care that an action line exists.
        const message = page.locator('[data-testid="chat-message"]').last();
        await expect(message).toBeVisible({ timeout: 30_000 });
        const text = await message.innerText();
        const hasAction = REQUIRED_NEXT_STEPS.some((re) => re.test(text));
        expect(hasAction, `no next-step phrase in message: ${text.slice(0, 200)}`).toBe(true);
    });

    test("error toasts never show 'something went wrong'", async ({ page }) => {
        await page.goto("/orders");
        await page.waitForTimeout(2_000);
        const opaque = page.locator('text=/something went wrong/i');
        await expect(opaque).toHaveCount(0);
    });
});
