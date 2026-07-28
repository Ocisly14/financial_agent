/**
 * Analysis framework prompt templates for the search MCP tools.
 * These are plain string constants (no interpolation) that instruct the main
 * agent how to interpret and present search result data.
 */

export const WEB_SEARCH_PROMPT_TEMPLATE: string =
  "Use the web search results provided in the generation context to answer the user's request. " +
  "You must cite the source URL for every factual claim you draw from the results, either inline or in a dedicated Sources section. " +
  "Note publication dates where available so the user can assess freshness; flag information older than 6 months as potentially outdated. " +
  "If the results contain conflicting information, present both sides and indicate which source supports each position. " +
  "Do not introduce facts, figures, or conclusions that are not present in the supplied search results.";

export const CRYPTO_RESEARCH_PROMPT_TEMPLATE: string =
  "Use the crypto research search results provided in the generation context to deliver a research-quality analysis of the requested topic. " +
  "Prioritise sources with strong credibility signals: institutional reports, academic studies, on-chain data providers, exchange disclosures, and established financial media over opinion pieces or anonymous commentary. " +
  "Where relevant, highlight on-chain metrics, protocol data, tokenomics, audits, or regulatory filings that appear in the results, and distinguish between hard evidence and analyst interpretation. " +
  "Cite the URL of every source you reference, and note publication dates to contextualise the currency of each finding. " +
  "Explicitly flag any evidence gaps, conflicting views, or areas where the search context is insufficient to draw a conclusion.";

export const INSTITUTIONAL_ADOPTION_PROMPT_TEMPLATE: string =
  "Use the institutional adoption search results provided in the generation context to identify and summarise concrete signals of institutional cryptocurrency adoption. " +
  "Focus on actionable evidence: ETF launches and flows, corporate treasury allocations, custody product announcements, regulatory filings (13F, S-1, prospectus), bank product rollouts, fund manager disclosures, and partnership agreements. " +
  "For each institution or event identified, extract the action taken, scale or amount where stated, timeline, and the filing or announcement source. " +
  "Cite the URL of every result you reference, and note publication dates to show whether signals are recent or historical. " +
  "Do not invent institution names, holding amounts, approval statuses, or dates that are not explicitly supported by the supplied results.";
