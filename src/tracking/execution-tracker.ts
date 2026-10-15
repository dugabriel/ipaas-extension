// ExecutionTracker: the polling state machine that follows a captured Message to
// a terminal state, fetches and orders its steps, and aggregates splitter child
// messages. Runs in the trusted service worker (Requirements 12-14).
//
// Design: ".kiro/specs/ipaas-helper-extension/design.md" — "ExecutionTracker State
// Machine". States: idle, executing, tracking_parent, tracking_parent_children,
// terminal, stopped_unauthorized.
//
// The tracker is written to be TESTABLE:
//  - All I/O is injected: it depends only on the three ApiClient methods it uses
//    (`getMessage`, `getSteps`, `getChildMessages`) and a port-like sink that
//    receives the typed `PortResponse` stream.
//  - Timing uses the global `setInterval`/`clearInterval` (3000ms), so fake timers
//    drive the cadence in tests.
//  - The decision logic lives in exported pure functions — `isTrackerTerminal`,
//    `aggregateChildren`, `orderSteps`, and `isStepError` — which the property
//    tests (12.2-12.5) target directly without any timers or I/O.

import type {
  ApiResult,
  ChildAggregate,
  PortResponse,
} from "../messaging/protocol";
import type {
  ExecutionStep,
  Message,
  MessageStatus,
} from "../models";
import { isTerminal } from "../models";

// ---------------------------------------------------------------------------
// Pure helpers — the property/unit tests (12.2-12.5) target these directly.
// ---------------------------------------------------------------------------

/**
 * Terminal detection for the whole tracker (Property 16; Req 12.3, 12.4, 14.1,
 * 14.3, 14.4).
 *
 * The tracker is terminal exactly when the parent is terminal AND all applicable
 * children are terminal. "All children terminal" means the number of observed
 * children in a Terminal_State equals `totalSplitMessage`, so late-appearing
 * children never let polling end early:
 *  - when `totalSplitMessage === 0`, there are no children, so terminality
 *    depends only on the parent (Req 12.4);
 *  - when `totalSplitMessage > 0`, every one of the `totalSplitMessage` children
 *    must be present and terminal (Req 14.4).
 */
export function isTrackerTerminal(
  parentStatus: MessageStatus,
  childStatuses: readonly string[],
  totalSplitMessage: number,
): boolean {
  if (!isTerminal(parentStatus)) {
    return false;
  }
  if (totalSplitMessage <= 0) {
    return true;
  }
  const terminalChildren = childStatuses.filter((s) => isTerminal(s)).length;
  return terminalChildren >= totalSplitMessage;
}

/**
 * Aggregates child message statuses against the parent's `totalSplitMessage`
 * (Property 18; Req 14.2).
 *
 * The reported `done`/`error`/`processing` counts are the exact counts of the
 * observed children and sum to the number of observed children; `total` is the
 * parent's `totalSplitMessage`. `REPROCESSED` children are not counted into any
 * of the three displayed buckets (only `DONE`, `ERROR`, and `PROCESSING` are
 * surfaced per Req 14.2).
 */
export function aggregateChildren(
  children: readonly Message[],
  total: number,
): ChildAggregate {
  let done = 0;
  let error = 0;
  let processing = 0;
  // Defensive: never throw on an unexpected (non-array) payload (Req 14.5).
  const list = Array.isArray(children) ? children : [];
  for (const child of list) {
    switch (child.status) {
      case "DONE":
        done++;
        break;
      case "ERROR":
        error++;
        break;
      case "PROCESSING":
        processing++;
        break;
      default:
        // REPROCESSED (or any other) is not one of the three displayed buckets.
        break;
    }
  }
  return { total, done, error, processing };
}

/**
 * Returns the steps in the order the Steps_API returned them (Property 15; Req
 * 13.2). The returned order is preserved verbatim; this returns a shallow copy
 * so callers never mutate the source array.
 */
export function orderSteps(steps: readonly ExecutionStep[]): ExecutionStep[] {
  // Defensive: tolerate an unexpected (non-array) payload (Req 13.4).
  return Array.isArray(steps) ? [...steps] : [];
}

/**
 * A step carries the error indicator if and only if its `status` is `ERROR`
 * (Property 15; Req 13.3), distinct from `DONE` and `PROCESSING`.
 */
export function isStepError(step: ExecutionStep): boolean {
  return step.status === "ERROR";
}

// ---------------------------------------------------------------------------
// Injectable dependencies.
// ---------------------------------------------------------------------------

/** The subset of ApiClient the tracker needs; injected so tests can stub it. */
export interface TrackerApi {
  getMessage(messageId: string): Promise<ApiResult<Message>>;
  getSteps(
    integrationId: string,
    createdDate: string,
    messageId: string,
  ): Promise<ApiResult<ExecutionStep[]>>;
  getChildMessages(
    originMessageId: string,
  ): Promise<ApiResult<{ items: Message[]; total: number }>>;
}

/** A port-like sink the tracker streams `PortResponse` updates to (Req 12.2). */
export interface UpdateSink {
  postMessage(response: PortResponse): void;
}

export interface ExecutionTrackerDeps {
  api: TrackerApi;
  sink: UpdateSink;
  /** Polling cadence; 3000ms per Req 12.1. Overridable only for tests. */
  intervalMs?: number;
  /** Clock for deriving the step/child date params. Defaults to `Date.now`. */
  now?: () => number;
}

/** Tracker lifecycle states (design "ExecutionTracker State Machine"). */
export type TrackerState =
  | "idle"
  | "tracking_parent"
  | "tracking_parent_children"
  | "terminal"
  | "stopped_unauthorized";

/** Default polling cadence (Req 12.1). */
const DEFAULT_INTERVAL_MS = 3000;

/**
 * Formats a Unix-millisecond instant as the `YYYY-MM-DD` date the Steps_API
 * `createdDate` path segment expects.
 */
function toCreatedDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A session-gone outcome that must halt all polling: an HTTP 401
 * (`unauthorized`, Req 12.5/16.2) or a cookie that is now absent/empty
 * (`no_session`, Req 16.3). Narrowing on this guard leaves only the three
 * transient kinds (`http_error`/`network`/`timeout`) on the remaining failures.
 */
function isSessionGone<T>(
  result: ApiResult<T>,
): result is { ok: false; kind: "unauthorized" } | { ok: false; kind: "no_session" } {
  return (
    result.ok === false &&
    (result.kind === "unauthorized" || result.kind === "no_session")
  );
}

// ---------------------------------------------------------------------------
// ExecutionTracker — the polling state machine.
// ---------------------------------------------------------------------------

export class ExecutionTracker {
  private readonly api: TrackerApi;
  private readonly sink: UpdateSink;
  private readonly intervalMs: number;
  private readonly now: () => number;

  private state: TrackerState = "idle";
  private timer: ReturnType<typeof setInterval> | null = null;

  private messageId = "";
  private integrationId = "";
  /** When tracking started; used to derive the step/child date params. */
  private startedAtMs = 0;
  /** True once a tick is in flight, so overlapping ticks are skipped. */
  private ticking = false;

  /** Last successfully fetched steps, retained across step-fetch failures (Req 13.4). */
  private lastSteps: ExecutionStep[] = [];
  /** Last known child messages, retained across child-fetch failures (Req 14.5). */
  private lastChildren: Message[] = [];
  /** Server-reported total number of split children (may exceed the 50 listed). */
  private lastChildTotal = 0;

  constructor(deps: ExecutionTrackerDeps) {
    this.api = deps.api;
    this.sink = deps.sink;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Current lifecycle state (exposed for tests). */
  getState(): TrackerState {
    return this.state;
  }

  /**
   * Begins tracking a captured Message_Id (Req 12.1). Runs an immediate first
   * tick, then schedules a tick every `intervalMs` until a terminal state or a
   * 401 stops polling.
   */
  start(messageId: string, integrationId: string): void {
    this.stopTimer();
    this.messageId = messageId;
    this.integrationId = integrationId;
    this.startedAtMs = this.now();
    this.state = "tracking_parent";
    this.lastSteps = [];
    this.lastChildren = [];

    // First poll happens right away so the UI updates without a 3s wait.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  /** Halts tracking and clears the interval (Req 12 / TRACK_STOP). */
  stop(): void {
    this.stopTimer();
    if (this.state !== "terminal" && this.state !== "stopped_unauthorized") {
      this.state = "idle";
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One polling cycle: parent → steps → (children) → emit (design sequence). */
  private async tick(): Promise<void> {
    // Never run two ticks concurrently (a slow network call must not stack).
    if (this.ticking) {
      return;
    }
    if (this.state !== "tracking_parent" && this.state !== "tracking_parent_children") {
      return;
    }
    this.ticking = true;
    try {
      // --- Parent message (Req 12.1, 12.2) ---
      const parentResult = await this.api.getMessage(this.messageId);
      if (isSessionGone(parentResult)) {
        this.haltUnauthorized(); // Req 12.5 / 16.2, 16.3
        return;
      }
      if (!parentResult.ok) {
        // Non-401 parent failure: keep polling, surface the transient error,
        // leave previously displayed data unchanged (Req 12.6, 18.1).
        this.emitTransient("parent", parentResult.kind);
        return;
      }
      const parent = parentResult.data;

      // --- Steps (Req 13.1-13.4) ---
      // A step-fetch failure retains the previously displayed steps (Req 13.4).
      const createdDate = toCreatedDate(this.startedAtMs);
      const stepsResult = await this.api.getSteps(
        this.integrationId,
        createdDate,
        this.messageId,
      );
      if (isSessionGone(stepsResult)) {
        this.haltUnauthorized(); // Req 12.5 / 16.2, 16.3
        return;
      }
      if (stepsResult.ok) {
        this.lastSteps = orderSteps(stepsResult.data);
      } else {
        this.emitTransient("steps", stepsResult.kind); // Req 13.4
      }

      // --- Children (Req 14.1-14.5) ---
      // Child polling begins only once the parent reports totalSplitMessage > 0.
      let childAggregate: ChildAggregate | undefined;
      const hasChildren = parent.totalSplitMessage > 0;
      if (hasChildren) {
        this.state = "tracking_parent_children"; // Req 14.1
        const childrenResult = await this.api.getChildMessages(this.messageId);
        if (isSessionGone(childrenResult)) {
          this.haltUnauthorized(); // Req 12.5 / 16.2, 16.3
          return;
        }
        if (childrenResult.ok) {
          this.lastChildren = childrenResult.data.items;
          this.lastChildTotal = childrenResult.data.total;
        } else {
          // Retain the last child display and keep polling (Req 14.5).
          this.emitTransient("children", childrenResult.kind);
        }
        // Aggregate against the parent's declared split total so the UI shows
        // "done/error/processing of totalSplitMessage" even when >50 children.
        childAggregate = aggregateChildren(
          this.lastChildren,
          parent.totalSplitMessage,
        );
      } else {
        // No splitter: parent-only tracking (Req 12.3).
        this.state = "tracking_parent";
        this.lastChildren = [];
      }

      // --- Terminal check + emit (Req 12.4, 14.4) ---
      const childStatuses = this.lastChildren.map((c) => c.status);
      const terminal = isTrackerTerminal(
        parent.status,
        childStatuses,
        parent.totalSplitMessage,
      );

      if (terminal) {
        this.emitTerminal(parent.status, childAggregate);
        this.state = "terminal";
        this.stopTimer(); // Req 12.4, 14.4
      } else {
        this.emitUpdate(parent, childAggregate);
      }
    } finally {
      this.ticking = false;
    }
  }

  // -------------------------------------------------------------------------
  // Port emitters — the single place each PortResponse variant is produced.
  // -------------------------------------------------------------------------

  /** Streams a per-tick update to the tracking UI (Req 12.2, 13, 14). */
  private emitUpdate(parent: Message, childAggregate?: ChildAggregate): void {
    this.sink.postMessage({
      type: "UPDATE",
      status: parent.status,
      executionTime: parent.executionTime,
      initialComponent: parent.initialComponent,
      finalComponent: parent.finalComponent,
      parent,
      steps: this.lastSteps,
      childAggregate,
      children: this.lastChildren,
      childTotal: this.lastChildTotal,
    });
  }

  /** Streams the final terminal update, then polling stops (Req 12.4, 14.4). */
  private emitTerminal(
    status: MessageStatus,
    childAggregate?: ChildAggregate,
  ): void {
    this.sink.postMessage({
      type: "TERMINAL",
      status,
      steps: this.lastSteps,
      childAggregate,
      children: this.lastChildren,
      childTotal: this.lastChildTotal,
    });
  }

  /** A 401 halts all polling (Req 12.5 / 16.2). */
  private haltUnauthorized(): void {
    this.sink.postMessage({ type: "UNAUTHORIZED" });
    this.state = "stopped_unauthorized";
    this.stopTimer();
  }

  /**
   * Surfaces a non-401 transient failure for a tick without stopping; polling
   * continues on the next interval (Req 12.6, 13.4, 14.5).
   */
  private emitTransient(
    scope: "parent" | "steps" | "children",
    kind: "http_error" | "network" | "timeout",
  ): void {
    this.sink.postMessage({ type: "TRANSIENT_ERROR", scope, kind });
  }
}
