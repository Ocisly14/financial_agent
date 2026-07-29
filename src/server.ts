import { createFinancialAgentApp } from "./agent/createApp.ts";
import { createHttpServer } from "./server/server.ts";
import { startMonitor } from "./trading/strategyMonitor.ts";

const PORT = parseInt(process.env["SERVER_PORT"] ?? "3000");

console.log("Starting Financial Agent server…");

const app = await createFinancialAgentApp();
const server = createHttpServer(app);

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Financial Agent ready at ${url}`);
  console.log(`  Chat UI:  ${url}/`);
  console.log(`  Health:   ${url}/health`);
  console.log(`  LLM:      ${process.env["LLM_PROVIDER"] ?? "mock"}`);
  startMonitor();
  console.log("  Strategy monitor started (auto-trading)");
});

server.on("error", (err) => {
  console.error("Server error:", err);
  process.exit(1);
});
