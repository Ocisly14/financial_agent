import assert from "node:assert/strict";
import test from "node:test";
import { createReadCompactedTaskDataTool } from "../readCompactedTaskDataTool.ts";

const taskResult = {
  event_id: "ev_result",
  kind: "task_result",
  payload: {
    generation_context: { data: {
      active_model_context: { model_id: "fm_aapl", revision: 4 },
      tool_outputs: [{ data: { value: 98_700_000_000 } }],
    } },
  },
};

test("reads only requested exact paths from a task result in the current session", async () => {
  const tool = createReadCompactedTaskDataTool({ loadEvents: async () => [taskResult] } as never);
  const result = await tool.execute({ source_event_id: "ev_result", paths: ["active_model_context.model_id", "tool_outputs.0.data.value"] },
    { sessionId: "room_1", tenantId: "agent_1" });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.generation_context?.data.values, {
    "active_model_context.model_id": "fm_aapl",
    "tool_outputs.0.data.value": 98_700_000_000,
  });
});

test("rejects broad or malformed reads", async () => {
  const tool = createReadCompactedTaskDataTool({ loadEvents: async () => [taskResult] } as never);
  const result = await tool.execute({ source_event_id: "ev_result", paths: ["active model"] },
    { sessionId: "room_1", tenantId: "agent_1" });
  assert.equal(result.error?.code, "invalid_compacted_task_read");
});
