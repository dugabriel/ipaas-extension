// Background service worker entry point (MV3).
//
// This is the single trusted context that performs cookie reads and cross-origin
// fetches. The popup and content script delegate to it via `chrome.runtime`
// messaging (design "High-Level Component Map"). Two channels are wired here:
//
//  1. A request/response channel over `chrome.runtime.onMessage` for the
//     short-lived operations (GET_SESSION, GET_ROLE, GET_FLOW, GET_KEYS, EXECUTE).
//  2. A long-lived tracking `Port` over `chrome.runtime.onConnect` (name
//     TRACK_PORT_NAME): TRACK_START starts an ExecutionTracker streaming updates
//     over the port; TRACK_STOP or disconnect stops it.
//
// Requirements: 16.1, 16.2, 16.3.
//
// The routing is factored into exported functions (`handleRequest`,
// `createPortHandler`) so the integration tests (task 15.3) can exercise it
// without the global `chrome.*` registration side effects.

import { ApiClient } from "./api/api-client";
import { getStoredToken, storeToken, decodeJwt } from "./auth/auth-service";
import { getHistory } from "./history";
import {
  ExecutionTracker,
  type TrackerApi,
  type UpdateSink,
} from "./tracking/execution-tracker";
import {
  TRACK_PORT_NAME,
  type Request,
  type ResponseFor,
  type SessionResponse,
  type PortRequest,
  type TrackStartMessage,
  type CaptureTokenResponse,
  type ApiResult,
} from "./messaging/protocol";

// ---------------------------------------------------------------------------
// Dependencies — real implementations by default; the integration tests inject
// stubs so the routing can be exercised without touching the network or cookies.
// ---------------------------------------------------------------------------

/** The AuthService surface the session/token routes depend on. */
export interface BackgroundAuth {
  getStoredToken: () => Promise<string | null>;
  storeToken: (token: string | null) => Promise<void>;
  decodeJwt: typeof decodeJwt;
}

export interface BackgroundDeps {
  api: ApiClient;
  auth: BackgroundAuth;
}

/** Builds the default dependencies (real ApiClient + AuthService functions). */
export function defaultDeps(): BackgroundDeps {
  return {
    api: new ApiClient(),
    auth: { getStoredToken, storeToken, decodeJwt },
  };
}

// ---------------------------------------------------------------------------
// Request/response routing (chrome.runtime.onMessage).
// ---------------------------------------------------------------------------

/**
 * Resolves the current session: reads the `jwt.token` cookie and structurally
 * decodes it. Returns `no_session` when the cookie is absent/empty (Req 16.3),
 * otherwise forwards the structural decode result (Req 2.3-2.5).
 */
/** iPaaS tab URL match used to find a tab we can capture the token from. */
const IPAAS_TAB_MATCH = "https://ipaas.totvs.app/*";

/**
 * Captures the token by delegating to the active iPaaS tab's content script
 * (Req 2.2). Finds the active iPaaS tab (falling back to any iPaaS tab), asks it
 * for `document.cookie`'s `jwt.token`, persists the result in the Session_Store,
 * and returns it. Returns `{ token: null }` when no iPaaS tab is available.
 */
async function captureFromActiveTab(
  deps: BackgroundDeps,
): Promise<CaptureTokenResponse> {
  const active = await chrome.tabs.query({
    url: IPAAS_TAB_MATCH,
    active: true,
    currentWindow: true,
  });
  const anyIpaas =
    active.length > 0
      ? active
      : await chrome.tabs.query({ url: IPAAS_TAB_MATCH });
  const tab = anyIpaas[0];
  if (!tab || tab.id === undefined) {
    return { token: null };
  }
  try {
    const reply = (await chrome.tabs.sendMessage(tab.id, {
      type: "CAPTURE_TOKEN",
    })) as CaptureTokenResponse | undefined;
    const token = reply?.token ?? null;
    await deps.auth.storeToken(token);
    return { token };
  } catch {
    return { token: null };
  }
}

async function handleSession(auth: BackgroundAuth): Promise<SessionResponse> {
  const token = await auth.getStoredToken();
  if (!token) {
    return { ok: false, kind: "no_session" };
  }
  const decoded = auth.decodeJwt(token);
  return decoded;
}

/**
 * Runs an authenticated ApiClient call and, on HTTP 401 (Req 16.2), re-captures
 * the token from the active iPaaS tab once and retries. If the re-capture yields
 * no new token (or the retry also 401s), the original `unauthorized` result is
 * returned so the UI can prompt the user to capture the session again.
 */
async function withReauth<T>(
  deps: BackgroundDeps,
  call: () => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  const first = await call();
  if (first.ok || first.kind !== "unauthorized") {
    return first;
  }
  const recaptured = await captureFromActiveTab(deps);
  if (!recaptured.token) {
    return first;
  }
  return call();
}

/**
 * Routes one request message to the AuthService/ApiClient and returns the typed
 * response. Every network outcome is already an `ApiResult<T>` from the client.
 */
export async function handleRequest<R extends Request>(
  request: R,
  deps: BackgroundDeps,
): Promise<ResponseFor[R["type"]]> {
  switch (request.type) {
    case "STORE_TOKEN":
      // Content script captured a token from document.cookie; persist it.
      await deps.auth.storeToken(request.token);
      return { ok: true } as ResponseFor[R["type"]];
    case "CAPTURE_TOKEN":
      // Popup asked the worker to capture; the worker delegates to the active
      // iPaaS tab's content script, persists the result, and returns it.
      return (await captureFromActiveTab(deps)) as ResponseFor[R["type"]];
    case "GET_HISTORY":
      return { entries: await getHistory() } as ResponseFor[R["type"]];
    case "GET_SESSION":
      return (await handleSession(deps.auth)) as ResponseFor[R["type"]];
    case "GET_ROLE":
      return (await withReauth(deps, () =>
        deps.api.getRole(request.userCode, request.tenantCode),
      )) as ResponseFor[R["type"]];
    case "GET_FLOW":
      return (await withReauth(deps, () =>
        deps.api.getIntegration(request.diagramId),
      )) as ResponseFor[R["type"]];
    case "GET_KEYS":
      return (await withReauth(deps, () =>
        deps.api.getKeys(),
      )) as ResponseFor[R["type"]];
    case "EXECUTE":
      return (await withReauth(deps, () =>
        deps.api.execute(
          request.integrationId,
          request.apiKey,
          request.body,
          request.headers,
        ),
      )) as ResponseFor[R["type"]];
    default: {
      // Exhaustiveness guard: an unknown `type` is a protocol violation.
      const never: never = request;
      throw new Error(
        `unknown request type: ${(never as { type?: unknown }).type}`,
      );
    }
  }
}

/**
 * The `chrome.runtime.onMessage` listener. Returns `true` to keep the message
 * channel open for the asynchronous `sendResponse`, as MV3 requires for promises.
 */
export function createMessageListener(deps: BackgroundDeps) {
  return (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    void handleRequest(message as Request, deps).then(
      (response) => sendResponse(response),
      // A thrown error (e.g. unknown type) must not leave the sender hanging.
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  };
}

// ---------------------------------------------------------------------------
// Tracking port routing (chrome.runtime.onConnect).
// ---------------------------------------------------------------------------

/** The subset of a `chrome.runtime.Port` the tracking handler uses. */
export interface TrackPort {
  name: string;
  postMessage: (message: unknown) => void;
  onMessage: { addListener: (cb: (message: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
}

/**
 * Wires a connected tracking port to an ExecutionTracker. The tracker streams
 * `PortResponse` updates straight to `port.postMessage`; TRACK_START begins
 * tracking a captured message id and TRACK_STOP (or disconnect) stops it.
 */
export function handleTrackPort(port: TrackPort, api: TrackerApi): void {
  const sink: UpdateSink = {
    postMessage: (response) => port.postMessage(response),
  };
  const tracker = new ExecutionTracker({ api, sink });

  port.onMessage.addListener((message: unknown) => {
    const request = message as PortRequest;
    if (request.type === "TRACK_START") {
      const start = request as TrackStartMessage;
      tracker.start(start.messageId, start.integrationId);
    } else if (request.type === "TRACK_STOP") {
      tracker.stop();
    }
  });

  // A disconnect (tab closed, UI torn down) halts polling (Req 12 / TRACK_STOP).
  port.onDisconnect.addListener(() => tracker.stop());
}

/** Builds the `chrome.runtime.onConnect` listener, ignoring non-tracking ports. */
export function createConnectListener(api: TrackerApi) {
  return (port: TrackPort): void => {
    if (port.name !== TRACK_PORT_NAME) {
      return;
    }
    handleTrackPort(port, api);
  };
}

// ---------------------------------------------------------------------------
// Registration — runs when the service worker is loaded by the browser.
// ---------------------------------------------------------------------------

/** Registers the message and connect listeners against the given deps. */
export function registerBackground(deps: BackgroundDeps): void {
  chrome.runtime.onMessage.addListener(createMessageListener(deps));
  chrome.runtime.onConnect.addListener(
    createConnectListener(deps.api) as (port: chrome.runtime.Port) => void,
  );
}

registerBackground(defaultDeps());
