# Working in this repo

## Prompt caching and cost

Subagent dispatch is dominated by one cost: the `[PROGRESS SO FAR]` region is re-sent on every step
of every dispatch, and on a real issuer it reaches tens of thousands of tokens. `splitForPromptCache`
(`src/framework/subagent.ts`) cuts it into blocks so most of it is billed as a cache read. Three
rules keep that working. Each of them exists because it was broken in production first.

### 1. Judge a caching change by weighted cost, never by `tokens_in`

Anthropic bills a prompt in three tiers: uncached input at 1.0x, a cache **read** at ~0.1x, and a
cache **write** at ~1.25x — above full price. `usage.input_tokens` is only the *uncached remainder*,
so a change can drop it by 93% and still cost more.

That is not hypothetical. A change that moved a 39k-token region out of `tokens_in` looked like a
huge win and was **23% more expensive**, because every step wrote a fresh entry and read none of them
back. Use:

```
equivalent input tokens = tokens_in + cache_read * 0.1 + cache_write * 1.25
```

`llmCostReport()` (`src/infra/llm/provider.ts`) computes this per agent, the router logs
`in= cache_r= cache_w=` on every call, and the DCF e2e writes the table into `summary.json`. **The
health signal is `cache_read_write_ratio`: below 1 means the run is writing entries it never reads.**

### 2. Nothing per-step or per-run may render inside the progress region

A provider matches a cached prefix by bytes, so one volatile value at the head of the region moves
the divergence point to the top of the prompt and no breakpoint below it is ever reachable. A step
counter rendered as the region's first line did exactly that, and silently disabled the rolling
breakpoint for every agent. Volatile content belongs *after* `{{progress}}` — see the `{{stepBudget}}`
slot in `src/agent/prompts/subagentPrompts.ts`.

The same applies inside a projection: order it so what never changes comes first, what grows at its
own end comes next, and what is rewritten each step comes last (`projectFinancialModelData`).

Guarded by `dcfPromptInjection.test.ts`, which dispatches each agent twice with identical tool
results and requires byte-identical regions.

### 3. Block boundaries are append-only

Byte stability is not enough — the *cut points* must also be stable. Re-cutting the region at a
freshly computed offset each step means the block that ended at the previous boundary is no longer
sent as its own block, so its entry cannot be matched and gets rewritten instead. A cut, once made,
stays a cut; later steps only add new ones after it. Guarded by `promptCacheSplit.test.ts`.

**Before merging any change to a prompt template, a progress projection, or `splitForPromptCache`:**
run `promptCacheSplit.test.ts` and `dcfPromptInjection.test.ts`, and compare the `cost` table in a
fresh e2e `summary.json` against the previous run.

## Tool schemas and agent prompts

- **State a required field's contract once, in the schema's `description`** — not as a conditional
  rule restated in a prompt. A prompt saying `rationale` was required "whenever a row merges >1
  component" while the schema required it unconditionally cost a 17k-token batch on every run: the
  model followed the prompt, and the schema rejected the whole batch over one row.
- **Validation collects every fault, not the first.** A rejected batch costs the agent the batch,
  not the row, so first-fault reporting turns one bad batch into one retry per fault — minutes each.
  See `validate` in `mcp_tools/financial-model/schemas.ts`.

## Testing agent behaviour

- **Stub tools through the path production uses.** Subagent progress injects
  `generation_context.data`, *not* the tool's `summary` (`sessionState.ts` → `renderSubagentProgress`).
  A stub returning only `summary` tests a branch the agents never take.
- **A tool called several times needs a payload per call.** Keying stub data by tool name collapses
  repeated calls to the last payload and quietly tests a run that never happens.
- **Drive the real definitions.** `createSubagentRegistry()` gives the actual prompts and tool sets;
  the three DCF agents build their regions differently, so covering one proves nothing about the others.
- **Prove a guard can fail.** After adding one, reintroduce the defect and confirm it goes red.
