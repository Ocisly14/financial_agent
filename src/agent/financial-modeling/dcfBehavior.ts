import type { SessionState } from "../../framework/sessionState.ts";
import type { SubagentBehavior } from "../../framework/subagent.ts";
import type { JsonObject, JsonValue } from "../../framework/types.ts";
import { INVOKE_SKILL } from "../../framework/skillTools.ts";
import { DELEGATE_TO_AGENT } from "../../framework/delegation.ts";

/**
 * financial_modeling's runtime behaviour, declared on its topology node instead of special-cased in
 * the framework. Everything here used to live inside framework/subagent.ts behind
 * `definition.name === "financial_modeling"` branches — which meant the DCF agent had a set of
 * behaviours no declaration showed and 280 lines of domain code sat in the framework. The framework
 * now only knows the hook shapes; what this agent does with them is this module's business.
 */
export const dcfBehavior: SubagentBehavior = {
  // Thread scope, not task scope: continuing a thread means the agent comes back to everything it
  // has done here, not just this round.
  projectProgress: (state, threadId) => projectFinancialModelProgress(
    state.subagentToolOutputs({ thread: threadId }),
    state.subagentToolErrors({ thread: threadId }),
    state.subagentNotes({ thread: threadId })),
  projectResultData: (outputs) => projectFinancialModelData(outputs),
  // A revision mutation must be the only call in its step: the engine serializes revisions, and a
  // mutation racing its own sibling reads is how a step ends up reasoning over a workbook it just
  // invalidated.
  soloTools: {
    tools: new Set(["create_financial_model", "apply_financial_model_operations", "archive_financial_model"]),
    code: "financial_mutation_serialization_required",
    message: "A revision mutation must be the only call in its step. Combine dependent changes into one ordered operations batch, then inspect the result in a later step.",
  },
  // The live revision is volatile, so it renders below {{progress}} with the step counter — inside
  // the region it would split the cached projection at whatever offset it happened to sit.
  stepStamp: (state, threadId) => {
    const live = latestFinancialModelState(state.subagentToolOutputs({ thread: threadId }));
    if (live.revision === undefined && live.model_id === undefined) return undefined;
    const stamp = [
      ...(live.model_id === undefined ? [] : [`model ${live.model_id}`]),
      ...(live.revision === undefined ? [] : [`revision ${live.revision}`]),
      ...(live.lifecycle_stage === undefined ? [] : [`stage ${live.lifecycle_stage}`]),
    ].join(", ");
    return `[LIVE MODEL STATE] ${stamp} — this is the current revision; base your next mutation on it.`;
  },
  // Refresh the model on resume (the request names a handle) and after a revision conflict, so the
  // next mutation is based on the revision that actually exists.
  refresh: {
    tool: "get_financial_model",
    onErrorCodes: new Set(["revision_conflict"]),
    input: ({ state, threadId, request }) => {
      const modelId = latestFinancialModelState(state.subagentToolOutputs({ thread: threadId })).model_id
        ?? request.model_id;
      return modelId ? { modelId } : undefined;
    },
  },
  // A spent budget is a resumable pause, not a failure — say exactly how to come back.
  exhaustedSummary: ({ state, threadId, request, maxToolSteps }) => {
    const latest = latestFinancialModelState(state.subagentToolOutputs({ thread: threadId }));
    return `Paused after ${maxToolSteps} tool steps; dispatch thread ${threadId} again to continue `
      + `${latest.model_id ?? request.model_id ?? "the model"} at revision ${latest.revision ?? "unknown"} `
      + `(${latest.lifecycle_stage ?? "unknown stage"}).`;
  },
};

export function latestFinancialModelState(outputs: ReturnType<SessionState["subagentToolOutputs"]>): {
  model_id?: string; revision?: number; lifecycle_stage?: string;
} {
  for (const output of [...outputs].reverse()) {
    const data = output.generation_context?.data;
    if (!data) continue;
    const result: { model_id?: string; revision?: number; lifecycle_stage?: string } = {};
    if (typeof data["model_id"] === "string") result.model_id = data["model_id"];
    if (typeof data["revision"] === "number") result.revision = data["revision"];
    if (typeof data["lifecycle_stage"] === "string") result.lifecycle_stage = data["lifecycle_stage"];
    if (Object.keys(result).length > 0) return result;
  }
  return {};
}

/** 查询类工具:结果不进 active_model_context,但 agent 的后续判断依赖它们,
 * 所以全部保留,否则 agent 会因为看不到结果而无限重查。 */
const FINANCIAL_QUERY_TOOLS = new Set([
  "financial_search", "read_search_result", "get_treasury_yield", "list_unified_statements", "get_unified_rows",
  "calculate_model_rows",
]);

/** Narrow reads must compose, but an agent can still issue arbitrary selectors. Keep a useful working
 * set rather than letting a long run grow its prompt without bound; the projection tells it if an
 * older slice was evicted, so an intentional reread is never mistaken for a missing tool result. */
const MAX_WORKBOOK_SLICES = 16;
/** Approx. 30k tokens of structured workbook evidence, leaving room for playbooks, notes, and tool specs. */
const MAX_WORKBOOK_SLICE_CONTEXT_CHARS = 120_000;

/** 提取结果里唯一跨步必需的是 ingestionRunId 和覆盖率;诊断按 playbook 只在覆盖率
 *  短缺时才用来判断,所以留计数加一个样本,不把 309 条原样搬进上下文。 */
function compactExtraction(raw: JsonObject): JsonObject {
  const diagnostics = Array.isArray(raw["diagnostics"]) ? raw["diagnostics"] : [];
  return {
    ...(raw["ingestionRunId"] !== undefined ? { ingestionRunId: raw["ingestionRunId"] } : {}),
    ...(raw["statementCoverage"] !== undefined ? { statementCoverage: raw["statementCoverage"] } : {}),
    ...(raw["filingInsightSetId"] !== undefined ? { filingInsightSetId: raw["filingInsightSetId"] } : {}),
    ...(raw["status"] !== undefined ? { status: raw["status"] } : {}),
    diagnostic_count: diagnostics.length,
    ...(diagnostics.length ? { diagnostic_sample: diagnostics.slice(0, 5) as JsonValue } : {}),
  };
}

function projectFinancialModelData(outputs: ReturnType<SessionState["subagentToolOutputs"]>): JsonObject {
  const revisions: JsonValue[] = [];
  let active: JsonObject = {};
  // The live revision is deliberately NOT a field of `active` — it changes on every mutation and is
  // rendered below the progress region instead. The slice-invalidation logic still needs to know
  // which revision the context is standing on, so it is tracked here rather than read back out of
  // the projection. Reading it from `active` is what made the two concerns one; they are not.
  let activeRevision: number | undefined;
  // A narrowed workbook read is evidence the agent explicitly asked for.  Unlike the overview,
  // multiple sections are meant to be read together (for example revenue plus history before a
  // forecast), so keep every distinct slice of the current revision instead of letting whichever
  // parallel call finishes last erase the others.  A new revision invalidates the whole cache.
  type CachedWorkbookSlice = { slice: JsonObject; sections: Set<string> };
  const workbookSlices = new Map<string, CachedWorkbookSlice>();
  let workbookSliceChars = 0;
  let evictedWorkbookSlices = 0;
  // Keyed by the delegate's THREAD, not by tool name. The fallback bucket below keys by tool name,
  // which is right for a tool asked one question and wrong for this one: delegation is called
  // repeatedly by construction, and three research questions would collapse to the last answer —
  // the same "that call never happened in the agent's eyes" failure the fallback exists to prevent.
  // By thread, a follow-up round replaces the round it continues (the delegate's own thread already
  // carries that history) while separate conversations accumulate.
  const delegatedResults = new Map<string, JsonValue>();
  const skillReferences = new Map<string, JsonValue>();
  // 技能正文必须跨步存活:这份投影就是 agent 每一步的全部上下文,漏掉它等于
  // invoke 完下一步方法论就没了。
  const skillGuidance = new Map<string, JsonValue>();
  const queryResults: JsonValue[] = [];
  let extraction: JsonObject | undefined;
  // Unknown tools get one durable slot per tool name. A fixed "last N events" window previously
  // forgot a successful tool after enough unrelated calls, which has the same repeat-loop failure
  // mode as dropping a workbook slice.
  const otherResults = new Map<string, JsonValue>();
  for (const output of outputs) {
    const data = output.generation_context?.data;
    if (data) {
      if (output.name === "read_skill_reference" && typeof data["content"] === "string") {
        skillReferences.set(`${data["skill"]}/${data["path"]}`, data["content"]);
        continue;
      }
      if (output.name === INVOKE_SKILL && typeof data["content"] === "string") {
        skillGuidance.set(String(data["skill"]), data["content"]);
        continue;
      }
      let captured = false;
      if (data["revision_summary"] && typeof data["revision_summary"] === "object") { revisions.push(data["revision_summary"]); captured = true; }
      if (output.name === DELEGATE_TO_AGENT && data["delegation"] && typeof data["delegation"] === "object") {
        const delegation = data["delegation"] as JsonObject;
        delegatedResults.set(String(delegation["thread"] ?? delegation["task_id"] ?? output.name), delegation);
        captured = true;
      }
      if (FINANCIAL_QUERY_TOOLS.has(output.name)) { queryResults.push({ tool: output.name, data }); captured = true; }
      // 提取结果单独一格,后一次覆盖前一次:agent 需要的是 ingestionRunId 和覆盖率,
      // 不是 309 条诊断乘以重试次数。没有这一格,提取就等于没发生过,agent 会一直重跑。
      if (data["extraction"] && typeof data["extraction"] === "object") {
        extraction = compactExtraction(data["extraction"] as JsonObject);
        captured = true;
      }
      if (typeof data["model_id"] === "string") {
        const modelId = data["model_id"];
        const revision = typeof data["revision"] === "number" ? data["revision"] : undefined;
        const currentModelId = typeof active["model_id"] === "string" ? active["model_id"] : undefined;
        const currentRevision = activeRevision;
        const changesModel = currentModelId !== undefined && currentModelId !== modelId;
        const advancesRevision = revision !== undefined && (currentRevision === undefined || revision > currentRevision);
        // Explicit historical reads must not make the current model context regress. They remain
        // visible in the tool trace, but forecasts and mutations should be grounded in the latest
        // revision the agent has already observed.
        if (currentModelId === modelId && revision !== undefined && currentRevision !== undefined && revision < currentRevision) {
          captured = true;
          continue;
        }
        // A mutation carries model_change_context, so its prior slices remain available as explicitly
        // revision-stamped history. A different model, or an unexplained revision advance, still
        // invalidates the cache conservatively.
        const hasChangeContext = data["model_change_context"] !== undefined;
        if (changesModel || (advancesRevision && !hasChangeContext)) {
          workbookSlices.clear();
          workbookSliceChars = 0;
          evictedWorkbookSlices = 0;
        }
        const retained = changesModel || advancesRevision ? {} : active;
        const incomingSlices = [
          ...(data["workbook_slice"] !== undefined ? [data["workbook_slice"]] : []),
        ];
        for (const rawSlice of incomingSlices) {
          if (!rawSlice || typeof rawSlice !== "object" || Array.isArray(rawSlice)) continue;
          const slice = rawSlice as JsonObject;
          const key = JSON.stringify(slice);
          // Refreshing an existing slice makes it most-recently used without duplicating it.
          if (workbookSlices.has(key)) {
            workbookSlices.delete(key);
            workbookSliceChars -= key.length;
          }
          const rows = Array.isArray(slice["rows"]) ? slice["rows"] : [];
          const sections = new Set(rows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row)
            && typeof (row as JsonObject)["section"] === "string" ? [(row as JsonObject)["section"] as string] : []));
          // A source-statement row has no DCF section field.  Treat an unclassifiable slice as
          // revision-bound, so it is still conservatively dropped on a normal revision advance.
          if (sections.size === 0) sections.add("<unknown>");
          // Once the agent reads a section at the current revision, that fresh slice supersedes an
          // older one for the same section. Other older sections remain historical working memory.
          if (revision !== undefined) {
            for (const [cachedKey, cached] of workbookSlices) {
              const cachedRevision = typeof cached.slice["revision"] === "number" ? cached.slice["revision"] : undefined;
              if (cachedRevision !== revision && [...cached.sections].some((section) => sections.has(section))) {
                workbookSlices.delete(cachedKey);
                workbookSliceChars -= cachedKey.length;
              }
            }
          }
          workbookSlices.set(key, { slice, sections });
          workbookSliceChars += key.length;
          // Keep the newly requested slice even if it alone exceeds the budget: hiding the result
          // the agent explicitly asked for recreates the repeat-loop we are preventing.
          while (workbookSlices.size > MAX_WORKBOOK_SLICES
            || (workbookSliceChars > MAX_WORKBOOK_SLICE_CONTEXT_CHARS && workbookSlices.size > 1)) {
            const oldest = workbookSlices.keys().next().value!;
            workbookSlices.delete(oldest);
            workbookSliceChars -= oldest.length;
            evictedWorkbookSlices += 1;
          }
        }
        // Key order inside this object is the same caching decision as the order of the projection
        // that holds it, and it matters more here, because this is the largest object in the
        // projection and it is rebuilt on every model read or write.
        //
        // `revision` used to sit second. It advances on every mutation, so a mutation step's cache
        // ended 40 bytes into a 28k object and the whole of it — workbook slices the agent had read
        // many steps ago and that had not changed since — was re-billed uncached. Measured on a TSLA
        // run: mutation steps read back 20,441 cached tokens where the steps around them read 49,058.
        //
        // It is no longer here at all: the one value that changes on literally every mutation is
        // rendered into the volatile {{stepBudget}} slot, BELOW the progress region, so it cannot
        // divide this object at any offset. Ordering alone would have been a convention held up by a
        // test; keeping it out of the region is structural. What stays here is the big, slow-moving
        // evidence, and the counters, which only move when the slices above them move anyway.
        active = { ...retained,
          ...(data["filing_insights"] !== undefined ? { filing_insights: data["filing_insights"] } : {}),
          ...(workbookSlices.size > 0 ? { workbook_slices: [...workbookSlices.values()].map((cached) => cached.slice) } : {}),
          ...(data["revision_history"] !== undefined ? { revision_history: data["revision_history"] } : {}),
          // model_overview is what both the read and the write answer with. Narrow reads accumulate
          // in workbook_slices for this revision; neither carries a whole workbook any more.
          ...(data["model_overview"] ? { model_overview: data["model_overview"] } : {}),
          ...(data["model_change_context"] ? { model_change_context: data["model_change_context"] } : {}),
          // Counters and stamps: small, and they move whenever anything above them moves.
          ...(workbookSlices.size > 0 ? { workbook_slices_context_chars: workbookSliceChars } : {}),
          ...(evictedWorkbookSlices > 0 ? { workbook_slices_evicted: evictedWorkbookSlices } : {}),
          ...(workbookSlices.size > 0 && [...workbookSlices.values()].some((cached) => cached.slice["revision"] !== revision)
            ? { workbook_slices_notice: "Slices from an earlier revision are historical context only; reread that section before using current values." } : {}),
          model_id: modelId,
          ...(typeof data["lifecycle_stage"] === "string" ? { lifecycle_stage: data["lifecycle_stage"] } : {}) };
        activeRevision = revision ?? (changesModel ? undefined : currentRevision);
        captured = true;
      }
      if (captured) continue;
    }
    // 兜底。上面每一个分支都是白名单,而白名单漏掉一个工具的后果不是"少点信息",
    // 是那次调用在 agent 眼里从未发生——它会照着看得见的证据重跑,直到步数耗尽。
    // summary 本来就是为压缩而写的,足够它知道自己做过什么。
    otherResults.set(output.name, { tool: output.name, summary: output.summary });
  }
  // Key order is a caching decision, not a reading one. A provider caches a request by byte prefix,
  // so the first field that changes between two steps ends the cache — and everything after it is
  // re-billed even if it is identical. `active_model_context` used to sit second: it is rewritten on
  // every model read or write, which left a common prefix of 76 bytes out of 38k and put the tens of
  // thousands of characters of never-changing playbook text behind it, paid for again every step.
  //
  // So: what never changes first, then what only ever grows at its own end, then what is rewritten
  // or windowed. It reads better this way too — the freshest state ends up nearest the question.
  // Ordered by how likely a field is to be UNCHANGED between two consecutive steps, most likely
  // first. Not by "static, then append-only, then rewritten" — that reading is wrong and cost real
  // money. A provider matches a byte prefix, so an append is a divergence point exactly like a
  // rewrite: everything below it is re-billed whether or not it changed. `revision_summaries` grows
  // by one small entry on every mutation, and ordering it above `active_model_context` therefore
  // re-bills the tens of thousands of tokens of workbook slices underneath it — slices that are
  // deliberately retained across a mutation precisely so they can be read from cache.
  //
  // So the question to ask of each field is not "does it only grow?" but "will this step change it?",
  // and the big, slow-moving evidence goes above the small, per-step bookkeeping.
  return {
    skill_guidance: Object.fromEntries(skillGuidance),
    skill_references: Object.fromEntries(skillReferences),
    ...(extraction ? { latest_extraction: extraction } : {}),
    // Untouched by a mutation step: these move only when their own tool is called.
    query_results: queryResults,
    other_results: [...otherResults.values()],
    // Always present, `[]` when empty, so the key never appears or disappears mid-run. Windowed for
    // the same reason as its neighbour: a delegate's account is prose, and four of them is already
    // more evidence than a forecast step can act on.
    latest_delegated_results: [...delegatedResults.values()].slice(-4),
    // Large, and stable across a mutation up to the per-step stamps at its own end.
    active_model_context: active,
    // One small entry per mutation — last, so it cannot push anything above it out of the cache.
    revision_summaries: revisions,
  };
}

export function projectFinancialModelProgress(
  outputs: ReturnType<SessionState["subagentToolOutputs"]>,
  errors: ReturnType<SessionState["subagentToolErrors"]>,
  notes: { step: number; note: string }[],
): string {
  if (outputs.length === 0 && errors.length === 0 && notes.length === 0) return "(no tools called yet)";
  // 步号是时间坐标:模型由此能看出"报错发生在很多步之前,此后没再失败",
  // 以及自己的 note 是否在原地重复。
  return JSON.stringify({ ...projectFinancialModelData(outputs),
    step_notes: notes.map((entry) => `step ${entry.step}: ${entry.note}`),
    errors: errors.slice(-2).map((error) => ({ ...(error.step === undefined ? {} : { at_step: error.step }),
      tool: error.name, code: error.code, message: error.message })) });
}

