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

That ratio only applies to providers with explicit breakpoints. Gemini's cache is implicit: there is
no write fee and no breakpoint, so `cache_w` is always 0 and the ratio is undefined — read the hit
rate instead, and watch the **absolute** `cache_r`. It moves in ~4096-token blocks, and a run whose
`cache_r` sits at a constant well below the prompt size is telling you exactly where the projection
diverges. Gemini will match a 376k-token prefix if you give it a stable one, so a low plateau is
never the provider's ceiling — it is ours.

### 2. Nothing per-step or per-run may render inside the progress region

A provider matches a cached prefix by bytes, so one volatile value at the head of the region moves
the divergence point to the top of the prompt and no breakpoint below it is ever reachable. A step
counter rendered as the region's first line did exactly that, and silently disabled the rolling
breakpoint for every agent. Volatile content belongs *after* `{{progress}}` — see the `{{stepBudget}}`
slot in `src/agent/prompts/subagentPrompts.ts`.

The same applies inside a projection, but order it by the right question. "Static, then append-only,
then rewritten" is the wrong rule and it cost real money: a prefix is matched by bytes, so an append
is a divergence point exactly like a rewrite — everything below it is re-billed whether or not it
changed. `revision_summaries` grows by one small entry per mutation, and sitting above
`active_model_context` it re-billed the tens of thousands of tokens of workbook slices underneath it,
slices that are retained across a mutation precisely so they can be read from cache.

So ask of each field **"will this step change it?"**, and order most-likely-unchanged first — big,
slow-moving evidence above small, per-step bookkeeping. This applies inside a nested object too:
`revision` advances every mutation and used to sit second inside `active_model_context`, ending that
step's cache forty bytes into a 28k object. Measured on a TSLA run, mutation steps read back 20,441
cached tokens where their neighbours read 49,058.

**Tool declarations are part of the cached prefix, ahead of the messages.** Measured against Gemini:
the same tools in a different order read back *zero* cached tokens. Reordering costs the whole prompt
on every step while changing nothing any test would notice — it shows up only as a larger bill.
`allowed` is a Map keyed by tool name so a skill's grant appends; `promptCacheSplit.test.ts` pins it.

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
