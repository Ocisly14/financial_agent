# Live Trading — Risk Disclosure and Acceptance (v1)

By accepting this agreement, you confirm the following before placing any **live** order through Financial Agent:

1. **Real money is at risk.** Live orders are submitted directly to a centralized exchange under your own API credentials. Losses are real and your responsibility.

2. **You understand the risk-limit settings.** Your account-level risk parameters (`max_order_notional_usd`, `daily_loss_limit_usd`, `slippage_bps_max`, `cooldown_seconds_after_fail`, asset allow/blocklists) are advisory floors / ceilings the agent enforces. They are not a substitute for your own oversight.

3. **The kill switch is yours.** You may flip the kill switch from the sidebar at any time; the agent will refuse all new write orders while it is ON. Open positions are *not* affected by the kill switch.

4. **Approvals are recorded.** Every action that submits a live order requires explicit approval. Both your approval and rejection events are recorded for audit and replay.

5. **Reconciliation is best-effort.** When an exchange returns an ambiguous response (timeout, 5xx, network reset), the agent marks the order as `unknown` and refuses retries on the same `client_order_id` until reconciliation resolves the true state. Wait for the resolved state in `/orders` before retrying manually.

6. **No financial advice.** Output from the agent is not investment advice. You are responsible for your own trading decisions, regulatory compliance in your jurisdiction, tax reporting, and exchange terms of service.

7. **Service availability.** Trading may be paused or refused by the platform's fail-closed gate when upstream dependencies are degraded. You will see a "Trading temporarily paused" message — switch to paper mode to continue testing.

8. **Geo-restrictions.** Live mode is unavailable in regions configured in `LIVE_TRADING_RESTRICTED_REGIONS` (HTTP 451). Paper mode remains available globally.

9. **Data handling.** Your encrypted exchange API credentials, trading decisions, risk audits, approval decisions, and order ledger rows are persisted for compliance and replay. See the platform's data-retention policy for retention windows.

10. **Withdraw consent.** You may withdraw this acceptance by switching to paper mode in Settings → Trading Risk Limits. A new acceptance is required to return to live mode.

By clicking **I Accept**, you affirm you have read, understand, and agree to the above.
