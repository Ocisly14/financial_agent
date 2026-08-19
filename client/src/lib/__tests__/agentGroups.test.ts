import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, agentsInOrder, humanizeAgent, isProgressAgent } from "../agentGroups.ts";

test("a nested delegate gets its own group, not \"Other\"", () => {
    // The regression: the pill knew only four agents, so a DCF's delegates showed as unlabelled
    // rows under "Other" while they were the ones actually working.
    const tasks = [
        { agent: "financial_modeling" },
        { agent: "statement_unification" },
        { agent: "spine_mapping" },
    ];
    assert.deepEqual(agentsInOrder(tasks), ["financial_modeling", "statement_unification", "spine_mapping"]);
    assert.equal(agentLabel("statement_unification"), "Statement unification agent");
    assert.equal(agentLabel("spine_mapping"), "Spine mapping agent");
});

test("an agent the client has never heard of is still named, never hidden", () => {
    // Adding an agent server-side must not require editing the client. "No icon for it" is not a
    // reason to tell the user "Other".
    assert.equal(agentLabel("credit_analysis"), "Credit analysis agent");
    assert.equal(humanizeAgent("some_new_worker"), "Some new worker agent");
    assert.deepEqual(agentsInOrder([{ agent: "credit_analysis" }]), ["credit_analysis"]);
});

test("groups appear in the order the agents first ran, each once", () => {
    const tasks = [
        { agent: "market_data" },
        { agent: "market_research" },
        { agent: "market_data" },
    ];
    assert.deepEqual(agentsInOrder(tasks), ["market_data", "market_research"]);
});

test("only agentless rows are uncategorized — those are the orchestrator's own calls", () => {
    assert.equal(isProgressAgent(undefined), false);
    assert.equal(isProgressAgent(""), false);
    assert.equal(isProgressAgent("spine_mapping"), true);
    assert.deepEqual(agentsInOrder([{}, { agent: "market_data" }]), ["market_data"]);
});
