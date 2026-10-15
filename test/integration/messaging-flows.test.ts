import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleRequest,
  createMessageListener,
  handleTrackPort,
  createConnectListener,
  type BackgroundDeps,
  type TrackPort,
} from "../../src/background";
import { ApiClient } from "../../src/api/api-client";
import { decodeJwt } from "../../src/auth/auth-service";
import {
  TRACK_PORT_NAME,
  type PortResponse,
  type TrackStartMessage,
} from "../../src/messaging/protocol";
import type {
  ExecutionResponse,
  ExecutionStep,
  Integration,
  Message,
  MessageStatus,
  Role,
} from "../../src/models";
import type { TrackerApi } from "../../src/tracking/execution-tracker";

// Integration tests for the end-to-end messaging flows (Task 15.3).
//
// These exercise the EXPORTED background routing (handleRequest,
// createMessageListener, handleTrackPort, createConnectListener) with injected
// deps and a stubbed cookie reader + fetch, so no global chrome.* registration
// or real network is needed. Two sides are covered:
//
//  - Request/response channel (Popup -> worker, Content -> worker):
//    GET_SESSION, GET_ROLE, GET_FLOW, GET_KEYS, EXECUTE routed through
//    handleRequest / the onMessage listener against canned 200 responses.
//  - Tracking Port channel (Content -> worker): a fake TrackPort driven through
//    the connect handler: TRACK_START -> streamed UPDATE(s) -> TERMINAL, with
//    polling stopping on terminal.
//
// Requirements: 1.4, 5.2, 11.1, 12.1

const HOST = "https://api-ipaas.totvs.app";

// A real, structurally-valid JWT (header.payload.signature) whose payload
// Base64URL-decodes to a known claims object. The Session_Cookie value IS this
// JWT, so the same string is used both for the GET_SESSION decode (real
// decodeJwt) and for the Bearer header on authenticated calls.
function base64Url(obj: unknown): string {
  // The claims JSON here is ASCII, so btoa (available in jsdom) is sufficient.
  const b64 = btoa(JSON.stringify(obj));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CLAIMS = {
  fullName: "Ada Lovelace",
  companyId: "acme",
  tenantCode: "tenant-7",
  env: "prod",
  sub: "user-42",
  exp: 1_900_000_000,
};
const JWT = `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(CLAIMS)}.sig`;
// The cookie value the stubbed reader returns is the JWT itself.
const TOKEN = JWT;

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Builds BackgroundDeps whose ApiClient is wired to a non-empty token and a
 * fetch stub that routes each endpoint URL to a canned 200 JSON response. The
 * `auth` surface uses the real decodeJwt and a readSessionToken returning TOKEN
 * (or null to simulate the no-session branch).
 */
function makeDeps(
  responses: {
    role?: Role;
    integrations?: unknown;
    keys?: unknown;
    execute?: ExecutionResponse;
  },
  opts: { token?: string | null } = {},
): { deps: BackgroundDeps; captured: () => CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const token = opts.token === undefined ? TOKEN : opts.token;

  const api = new ApiClient({
    readToken: async () => token,
    fetchFn: async (input, init) => {
      captured.push({
        url: input,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body:
          typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      let payload: unknown = {};
      if (input.includes("/roles/by-user-tenant")) {
        payload = responses.role;
      } else if (input.includes("/integrations?")) {
        payload = responses.integrations;
      } else if (input.includes("/keys?")) {
        payload = responses.keys;
      } else if (input.includes("/api-key/")) {
        payload = responses.execute;
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });

  const deps: BackgroundDeps = {
    api,
    auth: {
      getStoredToken: async () => token,
      storeToken: async () => {},
      decodeJwt,
    },
  };
  return { deps, captured: () => captured };
}

const ROLE: Role = {
  name: "Administrator",
  type: "ADMIN",
  gatewayEnabled: true,
  features: [
    { id: "f1", name: "builder.read" },
    { id: "f2", name: "builder.execute" },
  ],
};

const INTEGRATION: Integration = {
  id: "int-100",
  name: "Order Sync",
  active: true,
  status: "PUBLISHED",
  flow: {
    async: false,
    functions: {},
    activities: {},
    start: "start",
  },
};

const EXECUTION: ExecutionResponse = {
  status: "RECEIVED",
  messageId: "msg-777",
  timestamp: "2024-05-01T12:00:00Z",
};

describe("messaging flows — Popup/Content -> worker request/response channel", () => {
  it("GET_SESSION decodes the cookie JWT into claims (no network) (Req 1.4)", async () => {
    const { deps, captured } = makeDeps({});

    const response = await handleRequest({ type: "GET_SESSION" }, deps);

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.claims.sub).toBe("user-42");
      expect(response.claims.tenantCode).toBe("tenant-7");
      expect(response.claims.env).toBe("prod");
    }
    // Session resolution is cookie-only: no outbound request is made.
    expect(captured()).toHaveLength(0);
  });

  it("GET_SESSION returns no_session when the cookie is absent (Req 1.4)", async () => {
    const { deps } = makeDeps({}, { token: null });

    const response = await handleRequest({ type: "GET_SESSION" }, deps);

    expect(response).toEqual({ ok: false, kind: "no_session" });
  });

  it("GET_ROLE routes to the Roles_API and returns the decoded role", async () => {
    const { deps, captured } = makeDeps({ role: ROLE });

    const response = await handleRequest(
      { type: "GET_ROLE", userCode: "user-42", tenantCode: "tenant-7" },
      deps,
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toEqual(ROLE);
    }
    const req = captured()[0];
    expect(req.url).toBe(
      `${HOST}/connector-auth/api/v1/roles/by-user-tenant` +
        `?userCode=user-42&tenantCode=tenant-7`,
    );
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("GET_FLOW routes to the Integrations_API and selects the first item (Req 5.2)", async () => {
    const second: Integration = { ...INTEGRATION, id: "int-200", name: "Other" };
    const { deps, captured } = makeDeps({
      integrations: [INTEGRATION, second],
    });

    const response = await handleRequest(
      { type: "GET_FLOW", diagramId: "diagram-xyz" },
      deps,
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      // First-item selection (Req 5.2).
      expect(response.data).toEqual(INTEGRATION);
    }
    const req = captured()[0];
    expect(req.url).toContain(`${HOST}/ipaas/api/v3/integrations?`);
    expect(req.url).toContain("diagramId=diagram-xyz");
    expect(req.url).toContain("pageSize=1");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("GET_KEYS routes to the Keys_API with body {} and returns the key list", async () => {
    const keys = [
      {
        id: "k1",
        integrationId: "int-100",
        apiKey: "api-key-abc",
        eai: false,
        noContent: false,
        sync: true,
        diagram: { id: "diagram-xyz", name: "Diagram" },
        project: { id: "p1", name: "Project", type: "T" },
      },
    ];
    const { deps, captured } = makeDeps({ keys });

    const response = await handleRequest({ type: "GET_KEYS" }, deps);

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toEqual(keys);
    }
    const req = captured()[0];
    expect(req.url).toBe(`${HOST}/ipaas/api/v4/keys?page=0&pageSize=9999`);
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({});
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("EXECUTE routes to the Execute_API with body/headers (no Bearer) and captures the response (Req 11.1)", async () => {
    const { deps, captured } = makeDeps({ execute: EXECUTION });

    const body = { order: 1 };
    const headers = { "X-Trace": "trace-1" };
    const response = await handleRequest(
      {
        type: "EXECUTE",
        integrationId: "int-100",
        apiKey: "api-key-abc",
        body,
        headers,
      },
      deps,
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data.messageId).toBe("msg-777");
      expect(response.data.status).toBe("RECEIVED");
      expect(response.data.timestamp).toBe("2024-05-01T12:00:00Z");
    }
    const req = captured()[0];
    expect(req.url).toBe(
      `${HOST}/ipaas/api/v1/integrations/int-100/api-key/api-key-abc`,
    );
    expect(req.method).toBe("POST");
    expect(req.body).toEqual(body);
    expect(req.headers["X-Trace"]).toBe("trace-1");
    // The webhook authenticates via the apiKey in the URL; the session JWT is
    // intentionally NOT forwarded on executions (prevents the token from being
    // captured into the executed message's headers).
    expect(req.headers["Authorization"]).toBeUndefined();
  });

  it("drives GET_SESSION then GET_ROLE through the onMessage listener end-to-end (Req 1.4)", async () => {
    const { deps } = makeDeps({ role: ROLE });
    const listener = createMessageListener(deps);

    // GET_SESSION via the listener's async sendResponse contract.
    const sessionResponse = await new Promise<unknown>((resolve) => {
      const kept = listener({ type: "GET_SESSION" }, {} as never, resolve);
      // The MV3 contract: the listener keeps the channel open for the async reply.
      expect(kept).toBe(true);
    });
    expect(sessionResponse).toMatchObject({ ok: true });

    // GET_ROLE via the listener using codes a popup would derive from the claims.
    const roleResponse = await new Promise<unknown>((resolve) => {
      listener(
        { type: "GET_ROLE", userCode: "user-42", tenantCode: "tenant-7" },
        {} as never,
        resolve,
      );
    });
    expect(roleResponse).toMatchObject({ ok: true, data: ROLE });
  });
});

// ---------------------------------------------------------------------------
// Tracking Port channel — Content -> worker.
// ---------------------------------------------------------------------------

function makeMessage(
  status: MessageStatus,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "msg-777",
    integrationId: "int-100",
    diagramId: "diagram-xyz",
    diagramName: "Order Sync",
    status,
    executionTime: 4321,
    initialComponent: "webhook-start",
    finalComponent: "http-end",
    sourceType: "ORIGINAL",
    totalSplitMessage: 0,
    message: undefined,
    ...overrides,
  };
}

/**
 * A fake TrackPort with real listener registries and a captured postMessage
 * stream, matching the exported TrackPort shape the background handler uses.
 */
function makeFakePort(name: string = TRACK_PORT_NAME): {
  port: TrackPort;
  posted: PortResponse[];
  fireMessage: (message: unknown) => void;
  fireDisconnect: () => void;
} {
  const posted: PortResponse[] = [];
  const messageListeners: Array<(m: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];

  const port: TrackPort = {
    name,
    postMessage: (m) => posted.push(m as PortResponse),
    onMessage: { addListener: (cb) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
  };

  return {
    port,
    posted,
    fireMessage: (message) => messageListeners.forEach((cb) => cb(message)),
    fireDisconnect: () => disconnectListeners.forEach((cb) => cb()),
  };
}

/**
 * A TrackerApi stub whose getMessage walks the given status sequence across
 * successive calls (last entry repeats). Steps and children are empty.
 */
function makeTrackerApi(statuses: MessageStatus[]): {
  api: TrackerApi;
  getMessage: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const getMessage = vi.fn(async () => {
    const idx = Math.min(call, statuses.length - 1);
    call++;
    return { ok: true as const, data: makeMessage(statuses[idx]) };
  });
  const api: TrackerApi = {
    getMessage,
    getSteps: vi.fn(async () => ({
      ok: true as const,
      data: [] as ExecutionStep[],
    })),
    getChildMessages: vi.fn(async () => ({
      ok: true as const,
      data: { items: [] as Message[], total: 0 },
    })),
  };
  return { api, getMessage };
}

describe("messaging flows — tracking Port channel (TRACK_START -> UPDATE -> TERMINAL)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a port whose name is not the tracking port name", () => {
    const { api } = makeTrackerApi(["PROCESSING"]);
    const connect = createConnectListener(api);
    const { port, fireMessage, posted } = makeFakePort("some-other-port");

    connect(port);
    // No message listener should have been registered, so firing is a no-op.
    fireMessage({
      type: "TRACK_START",
      messageId: "msg-777",
      integrationId: "int-100",
    } satisfies TrackStartMessage);

    expect(posted).toHaveLength(0);
  });

  it("TRACK_START streams an UPDATE then a TERMINAL and stops polling (Req 12.1)", async () => {
    // Tick 1: PROCESSING -> UPDATE; tick 2 (after 3000ms): DONE -> TERMINAL.
    const { api, getMessage } = makeTrackerApi(["PROCESSING", "DONE"]);
    const connect = createConnectListener(api);
    const { port, posted, fireMessage } = makeFakePort();

    connect(port);
    fireMessage({
      type: "TRACK_START",
      messageId: "msg-777",
      integrationId: "int-100",
    } satisfies TrackStartMessage);

    // Immediate first tick: PROCESSING -> UPDATE.
    await vi.advanceTimersByTimeAsync(0);
    expect(getMessage).toHaveBeenCalledTimes(1);
    const update = posted.find((r) => r.type === "UPDATE");
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      type: "UPDATE",
      status: "PROCESSING",
      executionTime: 4321,
      initialComponent: "webhook-start",
      finalComponent: "http-end",
    });

    // Second tick after 3000ms: DONE -> TERMINAL, polling stops.
    await vi.advanceTimersByTimeAsync(3000);
    expect(getMessage).toHaveBeenCalledTimes(2);
    const terminal = posted.find((r) => r.type === "TERMINAL");
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ type: "TERMINAL", status: "DONE" });

    // No further polling after terminal.
    await vi.advanceTimersByTimeAsync(3000 * 3);
    expect(getMessage).toHaveBeenCalledTimes(2);
  });

  it("drives TRACK_START directly through handleTrackPort and reaches TERMINAL", async () => {
    const { api, getMessage } = makeTrackerApi(["DONE"]);
    const { port, posted, fireMessage } = makeFakePort();

    handleTrackPort(port, api);
    fireMessage({
      type: "TRACK_START",
      messageId: "msg-777",
      integrationId: "int-100",
    } satisfies TrackStartMessage);

    await vi.advanceTimersByTimeAsync(0);
    // First tick already DONE with no children -> immediate TERMINAL.
    expect(getMessage).toHaveBeenCalledTimes(1);
    expect(posted.some((r) => r.type === "TERMINAL")).toBe(true);
  });

  it("stops polling when the port disconnects before terminal (Req 12.1)", async () => {
    const { api, getMessage } = makeTrackerApi(["PROCESSING"]);
    const { port, fireMessage, fireDisconnect } = makeFakePort();

    handleTrackPort(port, api);
    fireMessage({
      type: "TRACK_START",
      messageId: "msg-777",
      integrationId: "int-100",
    } satisfies TrackStartMessage);

    await vi.advanceTimersByTimeAsync(0);
    expect(getMessage).toHaveBeenCalledTimes(1);

    // Disconnect halts the interval: no further polls.
    fireDisconnect();
    await vi.advanceTimersByTimeAsync(3000 * 3);
    expect(getMessage).toHaveBeenCalledTimes(1);
  });
});
