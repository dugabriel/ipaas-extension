// ApiClient: typed endpoint wrappers with Bearer injection, 30s timeout, and
// error classification. Runs in the trusted service-worker context (Req 16, 18).
//
// Every method resolves the Bearer header per call from the session cookie
// (short-circuiting `no_session` with NO outbound request when the cookie is
// empty, Req 16.3), issues `fetch` wrapped in a 30s AbortController, and maps the
// outcome to an `ApiResult<T>` (Req 16.1, 16.2, 18.1, 18.2, 18.3).

import type { ApiResult } from "../messaging/protocol";
import type {
  Role,
  Integration,
  ExecutionKey,
  ExecutionResponse,
  Message,
  ExecutionStep,
  DateWindow,
} from "../models";
import {
  getStoredToken as defaultReadSessionToken,
  buildBearerHeader,
} from "../auth/auth-service";

// ---------------------------------------------------------------------------
// Endpoint constants (exact URLs from the requirements Glossary).
// ---------------------------------------------------------------------------

const API_HOST = "https://api-ipaas.totvs.app";

/**
 * Fields requested from the Integrations_API. The Glossary specifies
 * `fieldsReturn=...`; we request exactly the Integration fields the extension
 * consumes (`id`, `name`, `active`, `status`, and the full `flow`).
 */
const INTEGRATION_FIELDS_RETURN = "id,name,active,status,flow";

/** Timeout applied to every outbound request (Req 18.2). */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Injectable dependencies — real implementations by default; property/unit
// tests stub `fetchFn` and `readToken` to exercise classification cheaply.
// ---------------------------------------------------------------------------

type FetchFn = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

type ReadTokenFn = () => Promise<string | null>;

export interface ApiClientDeps {
  fetchFn?: FetchFn;
  readToken?: ReadTokenFn;
}

export class ApiClient {
  private readonly fetchFn: FetchFn;
  private readonly readToken: ReadTokenFn;

  constructor(deps: ApiClientDeps = {}) {
    this.fetchFn =
      deps.fetchFn ?? ((input, init) => fetch(input, init));
    this.readToken = deps.readToken ?? defaultReadSessionToken;
  }

  // -------------------------------------------------------------------------
  // Typed endpoint wrappers.
  // -------------------------------------------------------------------------

  /** Roles_API — GET roles/by-user-tenant (Req 4.2, 16.1). */
  async getRole(
    userCode: string,
    tenantCode: string,
  ): Promise<ApiResult<Role>> {
    const url =
      `${API_HOST}/connector-auth/api/v1/roles/by-user-tenant` +
      `?userCode=${encodeURIComponent(userCode)}` +
      `&tenantCode=${encodeURIComponent(tenantCode)}`;
    return this.request<Role>("GET", url);
  }

  /**
   * Integrations_API — GET integrations?diagramId=...&fieldsReturn=...&pageSize=1.
   * Returns the first item (the flow payload), or null when no item is returned
   * (Req 5.2, 5.3).
   */
  async getIntegration(
    diagramId: string,
  ): Promise<ApiResult<Integration | null>> {
    const url =
      `${API_HOST}/ipaas/api/v3/integrations` +
      `?diagramId=${encodeURIComponent(diagramId)}` +
      `&fieldsReturn=${encodeURIComponent(INTEGRATION_FIELDS_RETURN)}` +
      `&pageSize=1`;
    const result = await this.request<unknown>("GET", url);
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: firstIntegration(result.data) };
  }

  /** Keys_API — POST keys?page=0&pageSize=9999 with body `{}` (Req 9.1). */
  async getKeys(): Promise<ApiResult<ExecutionKey[]>> {
    const url = `${API_HOST}/ipaas/api/v4/keys?page=0&pageSize=9999`;
    const result = await this.request<unknown>("POST", url, {});
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: keyEntries(result.data) };
  }

  /** Execute_API — POST integrations/{id}/api-key/{apiKey} (Req 11.1, 16.1). */
  async execute(
    integrationId: string,
    apiKey: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<ApiResult<ExecutionResponse>> {
    const url =
      `${API_HOST}/ipaas/api/v1/integrations/${encodeURIComponent(integrationId)}` +
      `/api-key/${encodeURIComponent(apiKey)}`;
    // The webhook authenticates via the apiKey in the URL, NOT the session JWT.
    // Sending a Bearer header would leak the user's token into the executed
    // message's captured headers, so we omit Authorization for executions
    // (Req 16.1 applies to data-read calls; execution uses the apiKey). A
    // captured session is still required to trigger (Req 16.3).
    return this.request<ExecutionResponse>("POST", url, body, headers, {
      omitAuth: true,
    });
  }

  /** Message_Detail_API — GET messages/{messageId} (Req 12). */
  async getMessage(messageId: string): Promise<ApiResult<Message>> {
    const url = `${API_HOST}/ipaas/api/v4/messages/${encodeURIComponent(messageId)}`;
    return this.request<Message>("GET", url);
  }

  /** Steps_API — GET steps/{integrationId}/{createdDate}/{messageId} (Req 13.1). */
  async getSteps(
    integrationId: string,
    createdDate: string,
    messageId: string,
  ): Promise<ApiResult<ExecutionStep[]>> {
    const url =
      `${API_HOST}/ipaas/api/v3/steps` +
      `/${encodeURIComponent(integrationId)}` +
      `/${encodeURIComponent(createdDate)}` +
      `/${encodeURIComponent(messageId)}`;
    const result = await this.request<unknown>("GET", url);
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: asArray<ExecutionStep>(result.data) };
  }

  /**
   * Child_Messages_API — GET messages?sourceTypes=SPLITTED&originMessageId=...
   * with the fixed status filter (Req 14.1).
   *
   * The optional date-window params are deliberately NOT sent: the live API
   * rejects ISO datetimes with HTTP 400, and the originMessageId already scopes
   * the result. We cap the page at 50 children and return the server `total` so
   * the UI can show "N of total" when a splitter produced more than 50.
   */
  async getChildMessages(
    originMessageId: string,
  ): Promise<ApiResult<{ items: Message[]; total: number }>> {
    const url =
      `${API_HOST}/ipaas/api/v4/messages` +
      `?sourceTypes=SPLITTED` +
      `&originMessageId=${encodeURIComponent(originMessageId)}` +
      `&page=0&pageSize=50` +
      `&status=DONE&status=ERROR&status=REPROCESSED&status=PROCESSING`;
    const result = await this.request<unknown>("GET", url);
    if (!result.ok) {
      return result;
    }
    const items = asArray<Message>(result.data);
    const total =
      result.data && typeof result.data === "object" && "total" in result.data
        ? Number((result.data as { total: unknown }).total) || items.length
        : items.length;
    return { ok: true, data: { items, total } };
  }

  // -------------------------------------------------------------------------
  // Core request: Bearer resolution, 30s timeout, outcome classification.
  // -------------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    options?: { omitAuth?: boolean },
  ): Promise<ApiResult<T>> {
    // Req 16.3 — resolve the Bearer header per call; a missing/empty cookie
    // short-circuits to `no_session` with NO outbound request.
    const token = await this.readToken();
    if (!token) {
      return { ok: false, kind: "no_session" };
    }

    const headers: Record<string, string> = {
      ...(extraHeaders ?? {}),
    };
    // Req 16.1 — attach the Bearer header on data calls. Execution calls set
    // omitAuth so the user's JWT is never forwarded to (and captured by) the
    // triggered webhook message.
    if (!options?.omitAuth) {
      headers.Authorization = buildBearerHeader(token);
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    // Req 18.2 — wrap every fetch in a 30s AbortController.
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      // Abort/timeout surfaces as an AbortError (Req 18.2); any other rejection
      // is a network failure (Req 18.1).
      if (isAbortError(err)) {
        return { ok: false, kind: "timeout" };
      }
      return { ok: false, kind: "network" };
    } finally {
      clearTimeout(timer);
    }

    // Req 16.2 — 401 → unauthorized.
    if (response.status === 401) {
      return { ok: false, kind: "unauthorized" };
    }
    // Req 18.3 — any other non-200 → http_error with the returned status.
    if (response.status !== 200) {
      return { ok: false, kind: "http_error", status: response.status };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  }
}

// ---------------------------------------------------------------------------
// Response shaping helpers.
// ---------------------------------------------------------------------------

/** Selects the first Integration from a list- or object-shaped response (Req 5.3). */
function firstIntegration(data: unknown): Integration | null {
  if (Array.isArray(data)) {
    return data.length > 0 ? (data[0] as Integration) : null;
  }
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items: unknown }).items;
    if (Array.isArray(items)) {
      return items.length > 0 ? (items[0] as Integration) : null;
    }
  }
  return null;
}

/** Normalizes the Keys_API payload to an ExecutionKey array. */
function keyEntries(data: unknown): ExecutionKey[] {
  if (Array.isArray(data)) {
    return data as ExecutionKey[];
  }
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items: unknown }).items;
    if (Array.isArray(items)) {
      return items as ExecutionKey[];
    }
  }
  return [];
}

/**
 * Normalizes a list-shaped API payload to an array. The iPaaS APIs sometimes
 * return a bare array and sometimes wrap it (`{items}`, `{content}`, `{steps}`),
 * so we unwrap the common envelopes; anything else yields an empty array. This
 * guarantees downstream consumers (the tracker's for-of / spread) always get an
 * iterable and never throw "x is not iterable".
 */
function asArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }
  if (data && typeof data === "object") {
    for (const key of ["items", "content", "steps", "messages", "data"]) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        return inner as T[];
      }
    }
  }
  return [];
}

/** True when a thrown value is an AbortController abort (timeout, Req 18.2). */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}
