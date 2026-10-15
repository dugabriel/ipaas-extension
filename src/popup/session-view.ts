// SessionPanel pure helpers (Req 3, 4).
//
// These functions build a plain view-model from decoded JwtClaims. They are
// deliberately pure and framework-free so popup.ts can import them and the
// property tests (tasks 6.2-6.4) can exercise them directly.
//
// Field mapping is INDEPENDENT per field: the absence of any one claim never
// changes the mapping of another (Req 3.4, Property 6).

import type { JwtClaims } from "../models";

/** Shown for any field whose source claim is absent or an empty string. */
export const NOT_AVAILABLE = "N/A";

/** Expiration classification against a reference time (Req 3.6, 3.7). */
export type ExpirationStatus = "expired" | "active" | "unavailable";

/** Expiration portion of the view-model. */
export interface ExpirationView {
  status: ExpirationStatus;
  /** Local date/time string when `exp` is a valid timestamp, else null (Req 3.5). */
  display: string | null;
}

/** Fields the Roles_API is keyed by, derived from the claims (Req 4.1). */
export interface SessionCodes {
  /** `userIdpId` (the IdP user UUID) when present and non-empty, else not-available. */
  userCode: string;
  /** `tenantIdpId` (the IdP tenant UUID) when present and non-empty, else not-available. */
  tenantCode: string;
}

/** The decoded-session view-model consumed by the popup renderer. */
export interface SessionView {
  company: string;
  user: string;
  env: string;
  expiration: ExpirationView;
  codes: SessionCodes;
}

/**
 * Returns the trimmed-presence value of a claim, or null when the claim is
 * absent, not a string, or an empty string. Used so each field falls back
 * independently (Req 3.4).
 */
function presentString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Maps the Company value ("empresa") from the JWT claims (Req 3.1).
 *
 * `companyId` is a UUID, so for readability we pair it with the human-readable
 * tenant slug (`domain`, falling back to `tenantCode`): "{slug} ({companyId})".
 * When only one of the two is present we show that one; not-available when
 * neither is present.
 */
export function mapCompany(claims: JwtClaims): string {
  const slug = presentString(claims.domain) ?? presentString(claims.tenantCode);
  const id = presentString(claims.companyId);
  if (slug !== null && id !== null) {
    return `${slug} (${id})`;
  }
  return slug ?? id ?? NOT_AVAILABLE;
}

/**
 * Maps the User value ("usuário") from the JWT claims (Req 3.2).
 * Prefers the most human-readable identity available: `fullName`, then
 * `login`, then `email`; not-available when none is present.
 */
export function mapUser(claims: JwtClaims): string {
  return (
    presentString(claims.fullName) ??
    presentString(claims.login) ??
    presentString(claims.email) ??
    NOT_AVAILABLE
  );
}

/**
 * Maps the environment value from the `env` claim (Req 3.3).
 * Not-available when absent/empty.
 */
export function mapEnv(claims: JwtClaims): string {
  return presentString(claims.env) ?? NOT_AVAILABLE;
}

/**
 * Derives the User_Code and Tenant_Code used by the Roles_API (Req 4.1).
 * The Roles_API is keyed by the IdP UUIDs: User_Code is `userIdpId` and
 * Tenant_Code is `tenantIdpId` (the slug `tenantCode` and the email `sub` are
 * NOT accepted by the endpoint).
 */
export function deriveCodes(claims: JwtClaims): SessionCodes {
  const userCode = presentString(claims.userIdpId) ?? NOT_AVAILABLE;
  const tenantCode = presentString(claims.tenantIdpId) ?? NOT_AVAILABLE;
  return { userCode, tenantCode };
}

/**
 * True only for a finite integer, used to validate the `exp` claim as a Unix
 * timestamp (Req 3.7). Non-integers, NaN, Infinity, and non-numbers are invalid.
 */
function isValidUnixTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Classifies the session expiration against `now` and formats `exp` for
 * display (Req 3.5, 3.6, 3.7).
 *
 * - expired     iff `exp` is a valid Unix-timestamp integer earlier than `now`
 * - active      iff `exp` is a valid timestamp not earlier than `now`
 * - unavailable  when `exp` is absent or not a valid integer
 *
 * `now` is the reference time in milliseconds since the epoch (e.g. Date.now()).
 * `exp` is interpreted as Unix seconds and compared after conversion to ms.
 */
export function classifyExpiration(claims: JwtClaims, now: number): ExpirationView {
  const exp = claims.exp;
  if (!isValidUnixTimestamp(exp)) {
    return { status: "unavailable", display: null };
  }
  const expMs = exp * 1000;
  const status: ExpirationStatus = expMs < now ? "expired" : "active";
  return { status, display: formatLocalDateTime(expMs) };
}

/** Formats an epoch-milliseconds instant as a human-readable local date/time (Req 3.5). */
function formatLocalDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/**
 * Builds the complete decoded-session view-model. Each field is mapped
 * independently so a missing claim never affects another field (Req 3, 4.1).
 */
export function buildSessionView(claims: JwtClaims, now: number): SessionView {
  return {
    company: mapCompany(claims),
    user: mapUser(claims),
    env: mapEnv(claims),
    expiration: classifyExpiration(claims, now),
    codes: deriveCodes(claims),
  };
}
