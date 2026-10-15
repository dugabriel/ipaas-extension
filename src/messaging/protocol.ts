/**
 * Typed messaging protocol between the UI contexts (popup, content script) and the
 * trusted background service worker.
 *
 * Two channels exist:
 *  1. A request/response channel over `chrome.runtime.sendMessage` for the short-lived
 *     operations (`GET_SESSION`, `GET_ROLE`, `GET_FLOW`, `GET_KEYS`, `EXECUTE`).
 *  2. A long-lived `chrome.runtime.Port` for execution tracking (`TRACK_START` /
 *     `TRACK_STOP`), over which the worker streams polling updates to the tracking UI.
 *
 * Every network outcome is modelled as an `ApiResult<T>` so each UI layer can switch on
 * `kind` and render the requirement-specified message (Requirements 16, 18).
 *
 * Shared data models are imported type-only from `../models` (authored separately).
 */
import type { HistoryEntry } from "../history";
import type {
  JwtDecodeResult,
  Role,
  Integration,
  ExecutionKey,
  ExecutionResponse,
  Message,
  MessageStatus,
  ExecutionStep,
} from "../models";

// ---------------------------------------------------------------------------
// ApiResult — the single, closed outcome type for every authenticated call.
// ---------------------------------------------------------------------------

/**
 * Result of any ApiClient call. UI layers switch on `kind` to render the
 * requirement-specified message. A missing cookie short-circuits to `no_session`
 * so no outbound request is ever made (Req 16.3).
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "unauthorized" } // HTTP 401 -> re-auth (Req 16.2)
  | { ok: false; kind: "http_error"; status: number } // non-200 non-401 (Req 18.3)
  | { ok: false; kind: "network" } // fetch rejection (Req 18.1)
  | { ok: false; kind: "timeout" } // >30s (Req 18.2)
  | { ok: false; kind: "no_session" }; // cookie absent/empty (Req 16.3)

// ---------------------------------------------------------------------------
// Request/response channel (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

/** Discriminator values for the short-lived request/response messages. */
export type RequestType =
  | "CAPTURE_TOKEN"
  | "STORE_TOKEN"
  | "GET_HISTORY"
  | "GET_SESSION"
  | "GET_ROLE"
  | "GET_FLOW"
  | "GET_KEYS"
  | "EXECUTE";

/**
 * Request sent to the content script of an iPaaS tab asking it to read
 * `jwt.token` from `document.cookie` and return it (Req 2.1-2.3). The worker
 * persists the returned value as the Captured_Token.
 */
export interface CaptureTokenRequest {
  type: "CAPTURE_TOKEN";
}

/** Response to CAPTURE_TOKEN: the captured token, or null when none/empty. */
export interface CaptureTokenResponse {
  token: string | null;
}

/**
 * Sent by the content script to the worker to persist a token it captured from
 * `document.cookie` into the Session_Store (Req 2.3, 2.4).
 */
export interface StoreTokenRequest {
  type: "STORE_TOKEN";
  token: string | null;
}

/** Response to STORE_TOKEN. */
export interface StoreTokenResponse {
  ok: true;
}

/** Request: read the Execution_History (Req 19.3). */
export interface GetHistoryRequest {
  type: "GET_HISTORY";
}

/** Response to GET_HISTORY: the recent executions, most recent first. */
export interface GetHistoryResponse {
  entries: HistoryEntry[];
}

/** Request: decode the current session JWT read from the cookie (Req 2). */
export interface GetSessionRequest {
  type: "GET_SESSION";
}

/** Request: resolve the effective role for the given user/tenant codes (Req 4). */
export interface GetRoleRequest {
  type: "GET_ROLE";
  userCode: string;
  tenantCode: string;
}

/** Request: load the Integration (flow) for a diagram id (Req 5). */
export interface GetFlowRequest {
  type: "GET_FLOW";
  diagramId: string;
}

/** Request: list the execution keys (Req 9). */
export interface GetKeysRequest {
  type: "GET_KEYS";
}

/** Request: trigger an authenticated execution (Req 11). */
export interface ExecuteRequest {
  type: "EXECUTE";
  integrationId: string;
  apiKey: string;
  body: unknown;
  headers: Record<string, string>;
}

/** Union of every request message sent to the worker. */
export type Request =
  | CaptureTokenRequest
  | StoreTokenRequest
  | GetHistoryRequest
  | GetSessionRequest
  | GetRoleRequest
  | GetFlowRequest
  | GetKeysRequest
  | ExecuteRequest;

/**
 * Response payload keyed by request type. `GET_SESSION` returns the structural decode
 * result (no network); the others return an `ApiResult` over their domain type.
 */
export interface ResponseFor {
  CAPTURE_TOKEN: CaptureTokenResponse;
  STORE_TOKEN: StoreTokenResponse;
  GET_HISTORY: GetHistoryResponse;
  GET_SESSION: SessionResponse;
  GET_ROLE: ApiResult<Role>;
  GET_FLOW: ApiResult<Integration | null>;
  GET_KEYS: ApiResult<ExecutionKey[]>;
  EXECUTE: ApiResult<ExecutionResponse>;
}

/** Convenience alias: the response type for a given request. */
export type Response<R extends Request> = ResponseFor[R["type"]];

/**
 * Session decode outcome returned by `GET_SESSION`.
 * `no_session` means the cookie was absent/empty (Req 2.2, 16.3); otherwise the
 * structural decode result is forwarded (Req 2.3-2.5).
 */
export type SessionResponse =
  | { ok: false; kind: "no_session" }
  | JwtDecodeResult;

// ---------------------------------------------------------------------------
// Tracking channel (long-lived chrome.runtime.Port)
// ---------------------------------------------------------------------------

/** Name used when opening the tracking `Port` via `chrome.runtime.connect`. */
export const TRACK_PORT_NAME = "ipaas-helper-tracking" as const;

/** Discriminator values for messages sent over the tracking port. */
export type PortMessageType = "TRACK_START" | "TRACK_STOP";

/**
 * Opens tracking for a captured message id (Req 12.1). Sent by the content-script
 * tracking UI immediately after the port connects.
 */
export interface TrackStartMessage {
  type: "TRACK_START";
  messageId: string;
  integrationId: string;
}

/** Halts tracking (Req 12). Equivalent to disconnecting the port. */
export interface TrackStopMessage {
  type: "TRACK_STOP";
}

/** Union of messages the UI posts to the worker over the tracking port. */
export type PortRequest = TrackStartMessage | TrackStopMessage;

/**
 * Aggregated counts of splitter child messages against the parent's
 * `totalSplitMessage` (Req 14.2). Counts never exceed `total` and sum to the number
 * of observed children.
 */
export interface ChildAggregate {
  total: number; // parent.totalSplitMessage
  done: number;
  error: number;
  processing: number;
}

/**
 * One streamed polling update for the tracking UI (Req 12.2, 13, 14).
 * `childAggregate` is present only once the parent reports `totalSplitMessage > 0`.
 */
export interface TrackingUpdate {
  type: "UPDATE";
  status: MessageStatus;
  executionTime: number;
  initialComponent: string;
  finalComponent: string;
  parent: Message;
  steps: ExecutionStep[];
  childAggregate?: ChildAggregate;
  /** The split child messages (capped at 50 by the ApiClient). */
  children?: Message[];
  /** Server-reported total number of split children (may exceed children.length). */
  childTotal?: number;
}

/** Terminal update: parent and all applicable children reached DONE/ERROR (Req 12.4, 14.4). */
export interface TrackingTerminal {
  type: "TERMINAL";
  status: MessageStatus;
  steps: ExecutionStep[];
  childAggregate?: ChildAggregate;
  children?: Message[];
  childTotal?: number;
}

/** A 401 halted all polling; the UI shows the re-auth message (Req 12.5). */
export interface TrackingUnauthorized {
  type: "UNAUTHORIZED";
}

/**
 * A non-401 transient failure on a tick; polling continues on the next 3s interval
 * (Req 12.6, 14.5). `scope` distinguishes a parent/step failure from a child failure.
 */
export interface TrackingTransientError {
  type: "TRANSIENT_ERROR";
  scope: "parent" | "steps" | "children";
  kind: "http_error" | "network" | "timeout";
}

/** Union of every message the worker streams back over the tracking port. */
export type PortResponse =
  | TrackingUpdate
  | TrackingTerminal
  | TrackingUnauthorized
  | TrackingTransientError;
