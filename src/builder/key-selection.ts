// Execution-key selection (Req 9.2-9.5).
//
// `selectExecutionKey` is a PURE function over the Keys_API result so it stays
// unit- and property-testable (Property 13). It picks the Execution_Key for the
// current Integration and exposes the `apiKey`, `sync`, and `noContent` values
// the execution flow needs. The outcome mapper (`resolveKeySelection`) turns a
// `GET_KEYS` ApiResult into a UI decision, mapping the no-match / 401 / other
// failure branches to the requirement-specified messages (Req 9.3-9.5). DOM
// rendering and the confirm->execute wiring live in later tasks (11.3).
import type { ApiResult } from "../messaging/protocol";
import type { ExecutionKey } from "../models";

/**
 * The subset of an Execution_Key the execution flow consumes once a key is
 * selected (Req 9.2): the `apiKey` used to trigger the run, plus the `sync` and
 * `noContent` flags that drive the response/tracking branches (Req 11).
 */
export interface SelectedKey {
  apiKey: string;
  sync: boolean;
  noContent: boolean;
}

/**
 * Selects the Execution_Key for the current Integration (Req 9.2): the key whose
 * `integrationId` equals the Integration `id` OR whose `diagram.id` equals the
 * current Diagram_Id. Returns the first matching key's `apiKey`/`sync`/
 * `noContent`, or null when no key matches (Req 9.3).
 *
 * Pure: it never touches the DOM or network, so a given (keys, integrationId,
 * diagramId) always yields the same result.
 */
export function selectExecutionKey(
  keys: readonly ExecutionKey[],
  integrationId: string,
  diagramId: string,
): SelectedKey | null {
  const match = keys.find(
    (key) =>
      key.integrationId === integrationId || key.diagram?.id === diagramId,
  );

  if (!match) {
    return null; // no key matches (Req 9.3)
  }

  return {
    apiKey: match.apiKey,
    sync: match.sync,
    noContent: match.noContent,
  };
}

// ---------------------------------------------------------------------------
// Key-selection outcome mapping (Req 9.3-9.5, 16.2)
// ---------------------------------------------------------------------------

/**
 * The result of resolving the current Integration's Execution_Key from a
 * `GET_KEYS` response. On `ok` the `key` is used to trigger the execution;
 * otherwise triggering is disabled and `message` explains why (Req 9.3-9.5).
 */
export type KeySelectionOutcome =
  | { ok: true; key: SelectedKey }
  | { ok: false; reason: KeyUnavailableReason; message: string };

export type KeyUnavailableReason =
  | "no_key" // success but no key matched (Req 9.3)
  | "unauthorized" // HTTP 401 -> re-auth (Req 9.4, 16.2)
  | "retrieve_failed"; // other non-200 / network / timeout / no session (Req 9.5)

/** User-visible branch messages, kept in one place for reuse by the UI. */
export const KEY_MESSAGES = {
  no_key: "No execution key was found for this integration.",
  unauthorized:
    "Your session is unauthorized or expired. Please re-authenticate.",
  retrieve_failed: "The execution key could not be retrieved.",
} as const;

/**
 * Maps a `GET_KEYS` ApiResult + the current Integration to a key-selection
 * outcome (Req 9.2-9.5).
 *
 * - success with a matching key -> ok, exposing apiKey/sync/noContent (Req 9.2);
 * - success with no matching key -> no_key, "no execution key found" and
 *   triggering disabled (Req 9.3);
 * - unauthorized (401) -> re-auth message (Req 9.4, 16.2);
 * - any other failure (non-200, network, timeout, no session) -> could-not-
 *   retrieve message (Req 9.5).
 */
export function resolveKeySelection(
  result: ApiResult<ExecutionKey[]>,
  integrationId: string,
  diagramId: string,
): KeySelectionOutcome {
  if (result.ok) {
    const key = selectExecutionKey(result.data, integrationId, diagramId);
    if (key === null) {
      return { ok: false, reason: "no_key", message: KEY_MESSAGES.no_key };
    }
    return { ok: true, key };
  }

  if (result.kind === "unauthorized") {
    return {
      ok: false,
      reason: "unauthorized",
      message: KEY_MESSAGES.unauthorized,
    };
  }

  return {
    ok: false,
    reason: "retrieve_failed",
    message: KEY_MESSAGES.retrieve_failed,
  };
}
