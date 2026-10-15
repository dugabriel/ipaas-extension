// AuthService: Captured_Token storage, JWT decoding, and Bearer-header
// construction. Runs in the trusted service-worker context (Req 2, 16).
//
// The raw session token is NOT read via `chrome.cookies` (that returned the
// wrong system's/profile's token for the shared TOTVS identity cookie). Instead
// the content script captures `jwt.token` from the iPaaS tab's `document.cookie`
// and hands it to the worker, which persists it here in `chrome.storage.session`
// (isolated per browser profile, cleared when the browser session ends).
import type { JwtClaims, JwtDecodeResult } from "../models";

/** Key under which the Captured_Token lives in `chrome.storage.session`. */
const TOKEN_KEY = "ipaas_jwt_token";

/** Raised when a Bearer header is requested without an active session (Req 16.3). */
export class NoSessionError extends Error {
  constructor() {
    super("no active session");
    this.name = "NoSessionError";
  }
}

/**
 * Returns the Captured_Token from the Session_Store, or null when none has been
 * captured or it is empty (Req 2.4, 16.3).
 */
export async function getStoredToken(): Promise<string | null> {
  const result = await chrome.storage.session.get(TOKEN_KEY);
  const token = result?.[TOKEN_KEY];
  return typeof token === "string" && token !== "" ? token : null;
}

/**
 * Persists a token captured by the content script into the Session_Store
 * (Req 2.2, 2.4). An empty/falsy value clears the stored token instead.
 */
export async function storeToken(token: string | null | undefined): Promise<void> {
  if (!token) {
    await chrome.storage.session.remove(TOKEN_KEY);
    return;
  }
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
}

/** Clears the Captured_Token from the Session_Store. */
export async function clearStoredToken(): Promise<void> {
  await chrome.storage.session.remove(TOKEN_KEY);
}

/**
 * Structural JWT decode (Req 2.3-2.5). Splits on `.`, requires exactly three
 * segments, Base64URL-decodes only the payload segment, and JSON-parses it.
 * The signature segment is never inspected and no crypto is performed.
 */
export function decodeJwt(token: string): JwtDecodeResult {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return { ok: false, reason: "malformed_structure" };
  }

  const payloadRaw = decodeBase64Url(segments[1]);
  if (payloadRaw === null) {
    return { ok: false, reason: "payload_not_json" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadRaw);
  } catch {
    return { ok: false, reason: "payload_not_json" };
  }

  if (!isJsonObject(parsed)) {
    return { ok: false, reason: "payload_not_json" };
  }

  return { ok: true, claims: parsed as JwtClaims };
}

/**
 * Builds the `Authorization` header value `Bearer {token}` (Req 16.1).
 * Throws NoSessionError when the token is missing or empty (Req 16.3).
 */
export function buildBearerHeader(token: string | null | undefined): string {
  if (!token) {
    throw new NoSessionError();
  }
  return `Bearer ${token}`;
}

/**
 * Base64URL-decodes a string into its UTF-8 text, or returns null when the
 * segment is not valid Base64URL.
 */
function decodeBase64Url(segment: string): string | null {
  // Base64URL uses - and _ in place of + and /, and omits padding.
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  // Reinterpret the binary string as UTF-8.
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** True only for plain JSON objects (not arrays or primitives). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
