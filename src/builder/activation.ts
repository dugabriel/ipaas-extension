// Pure builder-activation helpers (no DOM, no I/O) so they can be unit- and
// property-tested in isolation (Req 1.3, 5.1).
//
// A Builder_Page path matches `/builder/{diagramId}` with exactly one non-empty
// segment after `/builder/`. Trailing slashes are tolerated, but anything with
// zero or more than one segment after `/builder/` is not a builder path.
import type { ApiResult } from "../messaging/protocol";
import type { Integration } from "../models";

/**
 * Returns the path segments after `/builder/`, or null when the path is not
 * under `/builder/` at all. Leading/trailing empty segments (from leading or
 * trailing slashes) are dropped so `/builder/x/` yields `["x"]`.
 */
function builderSegments(path: string): string[] | null {
  // Strip a query string / fragment if one was passed in with the path.
  const pathname = path.split(/[?#]/, 1)[0];
  const parts = pathname.split("/").filter((segment) => segment.length > 0);
  if (parts.length === 0 || parts[0] !== "builder") {
    return null;
  }
  return parts.slice(1);
}

/**
 * Activation guard (Req 1.3): true if and only if the path matches
 * `/builder/{diagramId}` with a single non-empty diagram segment.
 *
 * `/builder/` (no segment) and `/builder/a/b` (multiple segments) are false, as
 * is any path not under `/builder/`.
 */
export function isBuilderPath(path: string): boolean {
  const segments = builderSegments(path);
  return segments !== null && segments.length === 1;
}

/**
 * Extracts the Diagram_Id from a builder path (Req 5.1): the single path segment
 * after `/builder/`. Returns null when the path is not a builder path.
 */
export function extractDiagramId(path: string): string | null {
  const segments = builderSegments(path);
  if (segments === null || segments.length !== 1) {
    return null;
  }
  return segments[0];
}

// ---------------------------------------------------------------------------
// Flow-load outcome mapping (Req 5.3-5.6, 16.2)
// ---------------------------------------------------------------------------

/**
 * The Integration fields exposed to the builder helpers once the flow loads
 * successfully (Req 5.3).
 */
export interface ActiveBuilderContext {
  diagramId: string;
  id: string;
  name: string;
  active: boolean;
  status: string;
  flow: Integration["flow"];
}

/**
 * The result of mapping a `GET_FLOW` response to an activation decision. When
 * `active` is true the helpers run with `context`; otherwise they stay inactive
 * and `message` explains why (Req 5.4, 5.5, 5.6).
 */
export type ActivationOutcome =
  | { active: true; context: ActiveBuilderContext }
  | { active: false; reason: FlowUnavailableReason; message: string };

export type FlowUnavailableReason =
  | "flow_unavailable" // no items returned (Req 5.4)
  | "unauthorized" // HTTP 401 -> re-auth (Req 5.5, 16.2)
  | "load_failed"; // other non-200 / network / timeout / no session (Req 5.6)

/** User-visible branch messages, kept in one place for reuse by the UI. */
export const FLOW_MESSAGES = {
  flow_unavailable: "Flow data is unavailable for this diagram.",
  unauthorized:
    "Your session is unauthorized or expired. Please re-authenticate.",
  load_failed: "The flow data could not be loaded.",
} as const;

/**
 * Maps a `GET_FLOW` ApiResult to an activation outcome (Req 5.3-5.6).
 *
 * - success with an Integration -> active, exposing id/name/active/status/flow;
 * - success with `null` (no items) -> inactive, "flow unavailable" (Req 5.4);
 * - unauthorized (401) -> inactive, re-auth message (Req 5.5, 16.2);
 * - any other failure -> inactive, "could not load" message (Req 5.6).
 */
export function resolveActivation(
  diagramId: string,
  result: ApiResult<Integration | null>,
): ActivationOutcome {
  if (result.ok) {
    const integration = result.data;
    if (integration === null) {
      return {
        active: false,
        reason: "flow_unavailable",
        message: FLOW_MESSAGES.flow_unavailable,
      };
    }
    return {
      active: true,
      context: {
        diagramId,
        id: integration.id,
        name: integration.name,
        active: integration.active,
        status: integration.status,
        flow: integration.flow,
      },
    };
  }

  if (result.kind === "unauthorized") {
    return {
      active: false,
      reason: "unauthorized",
      message: FLOW_MESSAGES.unauthorized,
    };
  }

  return {
    active: false,
    reason: "load_failed",
    message: FLOW_MESSAGES.load_failed,
  };
}
