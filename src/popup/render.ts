// SessionPanel pure render-branch logic (Req 2, 4, 16).
//
// This module turns the worker responses (GET_SESSION -> SessionResponse,
// GET_ROLE -> ApiResult<Role>) into a plain, framework-free view-model that
// describes exactly what the popup should render. Keeping the branch selection
// here (rather than in popup.ts) lets the unit tests (task 6.7) exercise every
// outcome without a DOM.
//
// The session branches mirror the JWT decode outcomes (Req 2.2/2.4/2.5) and the
// successful decode produces the Company/User/env/expiration/codes view-model
// built by session-view.ts (Req 3). The role branches mirror the Roles_API
// outcomes (Req 4.3-4.6, 16.2, 16.3).

import type { Role } from "../models";
import type { ApiResult, SessionResponse } from "../messaging/protocol";
import { buildSessionView, type SessionView } from "./session-view";

/** The decoded-session portion of the popup view-model. */
export type SessionSection =
  // No active session: cookie absent/empty (Req 2.2, 16.3).
  | { kind: "no_session" }
  // Token did not have exactly three segments (Req 2.4).
  | { kind: "malformed_structure" }
  // Payload segment was not valid JSON (Req 2.5).
  | { kind: "payload_not_json" }
  // Successful decode: the full session view-model (Req 3, 4.1).
  | { kind: "decoded"; view: SessionView };

/**
 * The role portion of the popup view-model.
 *
 * `role` is only resolved when the session decoded successfully (we need the
 * derived codes to query it). On every non-success outcome the JWT-derived
 * session data remains visible (Req 4.6).
 */
export type RoleSection =
  // No role request made (no decoded session to key it by).
  | { kind: "none" }
  // Roles_API success: show name/type and the feature-name list (Req 4.3, 4.4).
  | { kind: "role"; name: string; type: string; features: string[] }
  // HTTP 401: re-authenticate (Req 4.5, 16.2).
  | { kind: "unauthorized" }
  // Cookie went missing between decode and the role call (Req 16.3).
  | { kind: "no_session" }
  // HTTP 404: no role found for this user/tenant (Req 4.7).
  | { kind: "not_found" }
  // Any other non-200 / network / timeout: role unavailable (Req 4.6).
  | { kind: "unavailable" };

/** The complete popup view-model consumed by the DOM renderer. */
export interface PopupView {
  session: SessionSection;
  role: RoleSection;
}

/**
 * Maps a `GET_SESSION` response to the session section of the view-model.
 * `now` is the reference time (ms since epoch) used for expiration classification.
 */
export function toSessionSection(
  response: SessionResponse,
  now: number,
): SessionSection {
  if (response.ok) {
    return { kind: "decoded", view: buildSessionView(response.claims, now) };
  }
  // response.ok === false: either the no-session guard (`kind`) or a decode
  // failure forwarded from the worker (`reason`). The two arms discriminate on
  // different keys, so narrow with an `in` check.
  if ("kind" in response) {
    return { kind: "no_session" };
  }
  if (response.reason === "malformed_structure") {
    return { kind: "malformed_structure" };
  }
  return { kind: "payload_not_json" };
}

/**
 * Maps a `GET_ROLE` response (`ApiResult<Role>`) to the role section of the
 * view-model. The feature list is the `name` of every entry in `features`, in
 * order and without omission or duplication beyond the source array (Req 4.4,
 * Property 9).
 */
export function toRoleSection(result: ApiResult<Role>): RoleSection {
  if (result.ok) {
    return {
      kind: "role",
      name: result.data.name,
      type: result.data.type,
      features: result.data.features.map((f) => f.name),
    };
  }
  switch (result.kind) {
    case "unauthorized":
      return { kind: "unauthorized" };
    case "no_session":
      return { kind: "no_session" };
    // HTTP 404 -> no role found for this user/tenant (Req 4.7).
    case "http_error":
      return result.status === 404
        ? { kind: "not_found" }
        : { kind: "unavailable" };
    // network, timeout -> role unavailable (Req 4.6).
    default:
      return { kind: "unavailable" };
  }
}

/**
 * Builds the complete popup view-model from the two worker responses. When the
 * session did not decode successfully there is no role request to represent,
 * so the role section is `none`.
 */
export function buildPopupView(
  session: SessionResponse,
  role: ApiResult<Role> | null,
  now: number,
): PopupView {
  const sessionSection = toSessionSection(session, now);
  const roleSection: RoleSection =
    sessionSection.kind === "decoded" && role !== null
      ? toRoleSection(role)
      : { kind: "none" };
  return { session: sessionSection, role: roleSection };
}
