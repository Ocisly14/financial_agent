/** Helpers for Vertex AI auth via service account JSON in env. */

import { createLogger } from "../logger/logger.ts";

const log = createLogger("llm");

/**
 * Parse `GOOGLE_APPLICATION_CREDENTIALS_JSON` (full service account JSON as a string)
 * for `@ai-sdk/google-vertex` `googleAuthOptions.credentials`.
 *
 * Returns an empty object if unset or invalid so callers can still construct a client;
 * Vertex requests will fail auth until the env is fixed.
 */
export function googleApplicationCredentialsFromSetting(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return {};
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    log.warn(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON must be a JSON object (Google service account key)",
    );
    return {};
  } catch {
    log.warn(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON; Vertex AI authentication will fail",
    );
    return {};
  }
}
