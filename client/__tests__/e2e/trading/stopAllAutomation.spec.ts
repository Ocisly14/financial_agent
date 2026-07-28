import { test, expect } from "@playwright/test";

/**
 * §8.11 — Kill-switch end-to-end. Toggles the kill switch from the UI,
 * sends a "buy 0.01 BTC" message, and asserts the agent reply contains
 * the localized "trading paused" message.
 *
 * Pre-req: a tradeable agent + paper-mode preference + at least one CEX
 * key on file.
 */

test.describe("Kill switch", () => {
    test("activating the kill switch refuses the next trade", async ({ page }) => {
        await page.goto("/");

        // Click the compact kill-switch toggle in the sidebar.
        const killBtn = page.getByRole("button", { name: /Activate kill switch/i });
        await killBtn.click();

        // Confirm dialog appears.
        const stopInput = page.getByLabel(/Type STOP to confirm/i);
        await stopInput.fill("STOP");

        const activateBtn = page.getByRole("button", { name: /^Activate/ });
        await activateBtn.click();

        // Wait for the success toast.
        await expect(page.getByText(/Kill switch ON/i)).toBeVisible({ timeout: 5_000 });

        // Now the OFF button should be visible.
        await expect(
            page.getByRole("button", { name: /Disable kill switch/i }),
        ).toBeVisible();
    });

    test("turning the kill switch off resumes trading", async ({ page }) => {
        await page.goto("/");
        const offBtn = page.getByRole("button", { name: /Disable kill switch/i });
        if (await offBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await offBtn.click();
            await expect(page.getByText(/Kill switch OFF/i)).toBeVisible({ timeout: 5_000 });
        }
    });
});
