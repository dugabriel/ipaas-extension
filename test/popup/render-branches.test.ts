// Unit tests for the SessionPanel pure render-branch mappers and the
// expiration date/time formatting (task 6.7).
//
// Covers:
//  - Local date/time formatting under a fixed zone (expiration display, Req 3.5).
//  - Session branches: no-session, malformed structure, payload-not-JSON, and
//    successful decode (Req 2.2, 2.4, 2.5).
//  - Role branches: 401 re-auth (Req 4.5, 16.2), http_error/network/timeout ->
//    unavailable (Req 4.6), and ok -> role.
//  - buildPopupView retains the decoded JWT-derived session view regardless of
//    the role branch outcome (Req 4.6).
//
// _Requirements: 3.5, 2.2, 4.5_

import { describe, it, expect } from "vitest";
import type { JwtClaims, Role } from "../../src/models";
import type { ApiResult, SessionResponse } from "../../src/messaging/protocol";
import {
  toSessionSection,
  toRoleSection,
  buildPopupView,
} from "../../src/popup/render";
import { classifyExpiration } from "../../src/popup/session-view";

// A reference "now" (2024-01-01T00:00:00Z in epoch-ms) used throughout.
const NOW = Date.UTC(2024, 0, 1, 0, 0, 0);

// A minimal, fully populated set of claims the decode branch should surface.
const SAMPLE_CLAIMS: JwtClaims = {
  companyId: "ACME",
  domain: "acme-corp",
  fullName: "Ada Lovelace",
  env: "prod",
  sub: "user-123",
  userIdpId: "user-idp-uuid",
  tenantCode: "tenant-9",
  tenantIdpId: "tenant-idp-uuid",
  // exp in the future relative to NOW so expiration classifies as "active".
  exp: Math.floor(Date.UTC(2024, 5, 1, 12, 0, 0) / 1000),
};

const SAMPLE_ROLE: Role = {
  name: "Administrator",
  type: "SYSTEM",
  gatewayEnabled: true,
  features: [
    { id: "f1", name: "integrations.read" },
    { id: "f2", name: "integrations.write" },
    { id: "f3", name: "keys.manage" },
  ],
};

describe("classifyExpiration date/time formatting (Req 3.5)", () => {
  it("formats a known exp as the local date/time of that instant and marks it active", () => {
    // exp strictly after NOW -> active, with a non-null formatted display.
    const expSeconds = Math.floor(Date.UTC(2024, 5, 1, 12, 0, 0) / 1000);
    const claims: JwtClaims = { exp: expSeconds };

    const result = classifyExpiration(claims, NOW);

    expect(result.status).toBe("active");
    // The display is exactly the locale/zone-dependent rendering of the
    // epoch-ms instant (exp seconds * 1000). Comparing against the same
    // Date#toLocaleString keeps the assertion deterministic under whatever
    // fixed TZ/locale the test process runs with.
    expect(result.display).toBe(new Date(expSeconds * 1000).toLocaleString());
    // Sanity: the formatted string should mention the year of the instant.
    expect(result.display).toContain(
      String(new Date(expSeconds * 1000).getFullYear()),
    );
  });

  it("marks an exp earlier than now as expired while still formatting the instant", () => {
    const expSeconds = Math.floor(Date.UTC(2023, 0, 1, 0, 0, 0) / 1000);
    const claims: JwtClaims = { exp: expSeconds };

    const result = classifyExpiration(claims, NOW);

    expect(result.status).toBe("expired");
    expect(result.display).toBe(new Date(expSeconds * 1000).toLocaleString());
  });

  it("treats exp exactly equal to now as active (boundary)", () => {
    // exp is Unix seconds; pick a whole-second instant equal to NOW.
    const expSeconds = NOW / 1000;
    const claims: JwtClaims = { exp: expSeconds };

    const result = classifyExpiration(claims, NOW);

    expect(result.status).toBe("active");
    expect(result.display).toBe(new Date(NOW).toLocaleString());
  });

  it("reports unavailable with no display when exp is absent or not an integer", () => {
    expect(classifyExpiration({}, NOW)).toEqual({
      status: "unavailable",
      display: null,
    });
    expect(classifyExpiration({ exp: 1.5 }, NOW)).toEqual({
      status: "unavailable",
      display: null,
    });
    expect(
      classifyExpiration({ exp: "nope" } as unknown as JwtClaims, NOW),
    ).toEqual({ status: "unavailable", display: null });
  });
});

describe("toSessionSection branches (Req 2.2, 2.4, 2.5)", () => {
  it("maps a no-session response to { kind: 'no_session' }", () => {
    const response: SessionResponse = { ok: false, kind: "no_session" };
    expect(toSessionSection(response, NOW)).toEqual({ kind: "no_session" });
  });

  it("maps a malformed-structure decode failure to { kind: 'malformed_structure' }", () => {
    const response: SessionResponse = {
      ok: false,
      reason: "malformed_structure",
    };
    expect(toSessionSection(response, NOW)).toEqual({
      kind: "malformed_structure",
    });
  });

  it("maps a payload-not-JSON decode failure to { kind: 'payload_not_json' }", () => {
    const response: SessionResponse = { ok: false, reason: "payload_not_json" };
    expect(toSessionSection(response, NOW)).toEqual({
      kind: "payload_not_json",
    });
  });

  it("maps a successful decode to { kind: 'decoded', view } with the built session view", () => {
    const response: SessionResponse = { ok: true, claims: SAMPLE_CLAIMS };

    const section = toSessionSection(response, NOW);

    expect(section.kind).toBe("decoded");
    if (section.kind !== "decoded") throw new Error("expected decoded");
    expect(section.view).toEqual({
      company: "acme-corp (ACME)",
      user: "Ada Lovelace",
      env: "prod",
      expiration: {
        status: "active",
        display: new Date((SAMPLE_CLAIMS.exp as number) * 1000).toLocaleString(),
      },
      codes: { userCode: "user-idp-uuid", tenantCode: "tenant-idp-uuid" },
    });
  });
});

describe("toRoleSection branches (Req 4.5, 4.6, 16.2)", () => {
  it("maps a 401 result to { kind: 'unauthorized' } (re-auth branch)", () => {
    const result: ApiResult<Role> = { ok: false, kind: "unauthorized" };
    expect(toRoleSection(result)).toEqual({ kind: "unauthorized" });
  });

  it("maps http_error, network, and timeout to { kind: 'unavailable' }", () => {
    const httpError: ApiResult<Role> = {
      ok: false,
      kind: "http_error",
      status: 500,
    };
    const network: ApiResult<Role> = { ok: false, kind: "network" };
    const timeout: ApiResult<Role> = { ok: false, kind: "timeout" };

    expect(toRoleSection(httpError)).toEqual({ kind: "unavailable" });
    expect(toRoleSection(network)).toEqual({ kind: "unavailable" });
    expect(toRoleSection(timeout)).toEqual({ kind: "unavailable" });
  });

  it("maps a no-session result to { kind: 'no_session' }", () => {
    const result: ApiResult<Role> = { ok: false, kind: "no_session" };
    expect(toRoleSection(result)).toEqual({ kind: "no_session" });
  });

  it("maps an ok result to { kind: 'role', ... } with name, type, and the feature-name list in order", () => {
    const result: ApiResult<Role> = { ok: true, data: SAMPLE_ROLE };
    expect(toRoleSection(result)).toEqual({
      kind: "role",
      name: "Administrator",
      type: "SYSTEM",
      features: ["integrations.read", "integrations.write", "keys.manage"],
    });
  });
});

describe("buildPopupView retains JWT-derived data across role branches (Req 4.6)", () => {
  const decodedSession: SessionResponse = { ok: true, claims: SAMPLE_CLAIMS };
  const expectedView = {
    company: "acme-corp (ACME)",
    user: "Ada Lovelace",
    env: "prod",
    expiration: {
      status: "active" as const,
      display: new Date((SAMPLE_CLAIMS.exp as number) * 1000).toLocaleString(),
    },
    codes: { userCode: "user-idp-uuid", tenantCode: "tenant-idp-uuid" },
  };

  it("keeps the decoded session view when the role call returns 401", () => {
    const view = buildPopupView(
      decodedSession,
      { ok: false, kind: "unauthorized" },
      NOW,
    );

    expect(view.session).toEqual({ kind: "decoded", view: expectedView });
    expect(view.role).toEqual({ kind: "unauthorized" });
  });

  it("keeps the decoded session view when the role is unavailable", () => {
    const view = buildPopupView(
      decodedSession,
      { ok: false, kind: "http_error", status: 503 },
      NOW,
    );

    expect(view.session).toEqual({ kind: "decoded", view: expectedView });
    expect(view.role).toEqual({ kind: "unavailable" });
  });

  it("keeps the decoded session view and the resolved role on success", () => {
    const view = buildPopupView(
      decodedSession,
      { ok: true, data: SAMPLE_ROLE },
      NOW,
    );

    expect(view.session).toEqual({ kind: "decoded", view: expectedView });
    expect(view.role).toEqual({
      kind: "role",
      name: "Administrator",
      type: "SYSTEM",
      features: ["integrations.read", "integrations.write", "keys.manage"],
    });
  });

  it("represents no role section when the session did not decode", () => {
    const view = buildPopupView(
      { ok: false, kind: "no_session" },
      { ok: true, data: SAMPLE_ROLE },
      NOW,
    );

    expect(view.session).toEqual({ kind: "no_session" });
    // No decoded session to key a role request by, so the role section is none.
    expect(view.role).toEqual({ kind: "none" });
  });

  it("represents no role section when the role response is null (not yet requested)", () => {
    const view = buildPopupView(decodedSession, null, NOW);

    expect(view.session).toEqual({ kind: "decoded", view: expectedView });
    expect(view.role).toEqual({ kind: "none" });
  });
});
