// Confirm->execute outcome mapping (Req 9.1, 11.1-11.5).
//
// `resolveExecutionOutcome` is a PURE function over the `EXECUTE` ApiResult so
// it stays unit- and property-testable, mirroring `resolveActivation`
// (activation.ts) and `resolveKeySelection` (key-selection.ts). It turns the
// Execute_API result into a discriminated UI outcome:
//
//  - tracking       : a messageId was returned -> capture it for tracking and
//                     display the returned status/timestamp (Req 11.2);
//  - no_tracking_id  : the call succeeded but no messageId came back (the key's
//                     `noContent` is true, or the webhook is async-with-no-
//                     return) -> "triggered, no tracking id" (Req 11.3);
//  - unauthorized    : HTTP 401 -> re-auth message (Req 11.4, 16.2);
//  - trigger_failed  : any other failure (non-200, network, timeout, no
//                     session) -> could-not-trigger message (Req 11.5).
//
// Building the EXECUTE request (integrationId + apiKey + user body/headers +
// Bearer) and sending it to the worker (-> ApiClient.execute) is done by the
// caller; this module only maps the result the worker returns. DOM rendering
// and the modal wiring live with the content script (task 15.2).
import type { ApiResult, ExecuteRequest } from "../messaging/protocol";
import type { ExecutionResponse } from "../models";
import type { SelectedKey } from "./key-selection";

/**
 * Builds the `EXECUTE` request message sent to the worker (Req 9.1, 11.1). The
 * worker resolves the Bearer header per call and POSTs to the Execute_API for
 * `integrationId`/`apiKey` with the user-provided body and headers
 * (-> ApiClient.execute). Kept here so the content-script wiring has one place
 * to construct the message from the selected key and validated inputs.
 */
export function buildExecuteRequest(
  integrationId: string,
  selectedKey: SelectedKey,
  body: unknown,
  headers: Record<string, string>,
): ExecuteRequest {
  return {
    type: "EXECUTE",
    integrationId,
    apiKey: selectedKey.apiKey,
    body,
    headers,
  };
}

// ---------------------------------------------------------------------------
// Execution outcome mapping (Req 11.2-11.5, 16.2)
// ---------------------------------------------------------------------------

/**
 * The result of resolving an `EXECUTE` response into a UI decision.
 *
 * - `tracking`: a Message_Id was captured; the UI stores it to start tracking
 *   and displays the returned `status`/`timestamp` (Req 11.2);
 * - `no_tracking_id`: the execution was triggered but no Message_Id is
 *   available (Req 11.3) — still a success, just not trackable;
 * - `unauthorized`: a 401 re-auth outcome (Req 11.4, 16.2);
 * - `trigger_failed`: the execution could not be triggered (Req 11.5).
 */
export type ExecutionOutcome =
  | {
      kind: "tracking";
      messageId: string;
      status: string;
      timestamp: string;
    }
  | { kind: "no_tracking_id"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "trigger_failed"; message: string };

/** User-visible branch messages, kept in one place for reuse by the UI. */
export const EXECUTION_MESSAGES = {
  no_tracking_id:
    "Execução disparada com sucesso. Não há rastreamento porque o webhook " +
    "está configurado para descartar o retorno (sem Message_Id). Para " +
    "acompanhar os steps aqui, desative a opção de descartar o retorno no " +
    "webhook.",
  unauthorized:
    "Sua sessão expirou ou não está autorizada. Capture a sessão novamente.",
  trigger_failed: "Não foi possível disparar a execução.",
} as const;

/**
 * Maps an `EXECUTE` ApiResult to an execution outcome (Req 11.2-11.5).
 *
 * On success the branch is decided by whether the Execute_API returned a
 * `messageId`: present -> `tracking` with the id plus the response
 * `status`/`timestamp` (Req 11.2); absent -> `no_tracking_id` (Req 11.3). A
 * missing `messageId` is expected when the selected key's `noContent` is true
 * or the webhook is asynchronous without a return, so `selectedKey` is accepted
 * for context even though the response alone determines the branch.
 *
 * On failure: 401 -> `unauthorized` (Req 11.4, 16.2); any other failure
 * (non-200, network, timeout, no session) -> `trigger_failed` (Req 11.5).
 */
export function resolveExecutionOutcome(
  result: ApiResult<ExecutionResponse>,
  _selectedKey: SelectedKey,
): ExecutionOutcome {
  if (result.ok) {
    const { messageId, status, timestamp } = result.data;
    if (messageId !== undefined && messageId !== "") {
      return { kind: "tracking", messageId, status, timestamp };
    }
    // Success but no tracking id: noContent key or async-no-return (Req 11.3).
    return {
      kind: "no_tracking_id",
      message: EXECUTION_MESSAGES.no_tracking_id,
    };
  }

  if (result.kind === "unauthorized") {
    return { kind: "unauthorized", message: EXECUTION_MESSAGES.unauthorized };
  }

  return { kind: "trigger_failed", message: EXECUTION_MESSAGES.trigger_failed };
}
