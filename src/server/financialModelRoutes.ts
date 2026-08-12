import { FinancialModelError } from "../financial-model/errors.ts";
import type { FinancialModelSnapshot } from "../financial-model/operations.ts";
import { FinancialModelService, type RevisionChangeSummary } from "../financial-model/service.ts";
import type { ModelStore, ModelView } from "../financial-model/store.ts";
import type { ModelContextView } from "../financial-model/views.ts";
import type { SourceReviewStore } from "../infra/xbrl/sourceReviewStore.ts";

export type FinancialModelReadDeps = {
  modelStore: ModelStore<FinancialModelSnapshot, RevisionChangeSummary>;
  /** Owns the full statement_unification artifact, which is intentionally
   * outside the compact, revisioned DCF snapshot. */
  sourceReviewStore?: SourceReviewStore;
};

/** The service takes a session id only to stamp `creatingSessionId` on writes.
 *  These routes never write, so a constant is honest — inventing a session id
 *  here would put a fictional author on nothing. */
const READ_SESSION_ID = "http-read";

export type RouteResult<T> = { status: 200; body: T } | { status: 404; body: { success: false; error: string } };

/** The tab strip's source. A topic id IS its session id, so ownership is a
 *  plain filter — no join table needed. Archived models are excluded: history
 *  should stay readable by id, but a live tab strip is not where it belongs. */
export function listTopicModels(
  deps: FinancialModelReadDeps,
  agentId: string,
  topicId: string,
): { status: 200; body: { models: ModelView[] } } {
  const service = new FinancialModelService(deps.modelStore, READ_SESSION_ID);
  const models = service.listModels({ ownerAgentId: agentId, originSessionId: topicId, includeArchived: false });
  return { status: 200, body: { models } };
}

/** Passing no options is what makes `getModel` return the full context view
 *  rather than a slice — see `FinancialModelService.getModel`. */
export function getModelContext(
  deps: FinancialModelReadDeps,
  modelId: string,
): RouteResult<ModelContextView> {
  const service = new FinancialModelService(deps.modelStore, READ_SESSION_ID);
  try {
    // The three as-filed statements ride along at every lifecycle stage. The
    // engine only volunteers them while the spine is unmapped, on the reasoning
    // that a mapped model is a DCF and not a source review — true for the agent,
    // which reads this view into a prompt budget, and wrong for a human, who
    // wants to check a DCF row against the filing it came from precisely when
    // the model is finished.
    const unifiedStatements = deps.sourceReviewStore?.get(modelId)?.unifiedStatements;
    return {
      status: 200,
      body: service.getModel(modelId, {
        includeSourceStatements: true,
        ...(unifiedStatements ? { unifiedStatements } : {}),
      }) as ModelContextView,
    };
  } catch (error) {
    if (error instanceof FinancialModelError && error.code === "financial_model_not_found") {
      return { status: 404, body: { success: false, error: `model not found: ${modelId}` } };
    }
    throw error;
  }
}
