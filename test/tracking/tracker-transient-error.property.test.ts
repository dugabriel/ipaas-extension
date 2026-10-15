import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { ExecutionTracker } from "../../src/tracking/execution-tracker";
import type { TrackerApi, UpdateSink } from "../../src/tracking/execution-tracker";
import type { ApiResult, PortResponse } from "../../src/messaging/protocol";
import type { Message, ExecutionStep } from "../../src/models";

// Feature: ipaas-helper-extension, Property 17: Tracker transient-error continuation
// Validates: Requirements 12.6, 14.5
//
// For any non-401 transient failure (a non-200 http_error, a network rejection,
// or a timeout) returned by the parent fetch on a polling tick, the
// ExecutionTracker must NOT stop: it stays in a polling state
// (tracking_parent / tracking_parent_children, never terminal or
// stopped_unauthorized), surfaces a TRANSIENT_ERROR to the sink, and retries on
// the next 3000ms interval.
//
// The tracker's only I/O is the injected `api` (getMessage/getSteps/
// getChildMessages) and the `sink` that receives the PortResponse stream.
// Timing uses the global setInterval, so vi.useFakeTimers() drives the cadence.
// `tick()` is async, so timers are advanced with advanceTimersByTimeAsync and
// microtasks are flushed between assertions.

/** A fast-check generator for the three transient (non-401) parent failures. */
function transientFailure(): fc.Arbitrary<ApiResult<Message>> {
  return fc.oneof(
    fc
      .integer({ min: 400, max: 599 })
      .filter((status) => status !== 401)
      .map(
        (status) =>
          ({ ok: false, kind: "http_error", status }) as ApiResult<Message>,
      ),
    fc.constant({ ok: false, kind: "network" } as ApiResult<Message>),
    fc.constant({ ok: false, kind: "timeout" } as ApiResult<Message>),
  );
}

/** Collects every PortResponse the tracker streams out. */
function makeSink(): { sink: UpdateSink; responses: PortResponse[] } {
  const responses: PortResponse[] = [];
  const sink: UpdateSink = {
    postMessage(response) {
      responses.push(response);
    },
  };
  return { sink, responses };
}

describe("Property 17: Tracker transient-error continuation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling and retries after a non-401 parent failure (Req 12.6, 14.5)", async () => {
    await fc.assert(
      fc.asyncProperty(transientFailure(), async (failure) => {
        const getMessage = vi.fn<(messageId: string) => Promise<ApiResult<Message>>>(
          async () => failure,
        );
        // Steps/children are never reached because a parent failure returns
        // early, but the stubs must exist to satisfy the TrackerApi shape.
        const api: TrackerApi = {
          getMessage,
          getSteps: vi.fn(
            async (): Promise<ApiResult<ExecutionStep[]>> => ({ ok: true, data: [] }),
          ),
          getChildMessages: vi.fn(
            async (): Promise<ApiResult<{ items: Message[]; total: number }>> => ({
              ok: true,
              data: { items: [], total: 0 },
            }),
          ),
        };
        const { sink, responses } = makeSink();

        const tracker = new ExecutionTracker({ api, sink });

        // Start tracking: fires an immediate first tick (async) + schedules the
        // 3000ms interval. Flush microtasks so the first tick fully resolves.
        tracker.start("message-1", "integration-1");
        await vi.advanceTimersByTimeAsync(0);

        // The first tick saw a transient failure.
        expect(getMessage).toHaveBeenCalledTimes(1);

        // The tracker stayed in a polling state — never terminal / unauthorized.
        const stateAfterFirstTick = tracker.getState();
        expect(stateAfterFirstTick).not.toBe("terminal");
        expect(stateAfterFirstTick).not.toBe("stopped_unauthorized");
        expect([
          "tracking_parent",
          "tracking_parent_children",
        ]).toContain(stateAfterFirstTick);

        // A TRANSIENT_ERROR for the parent scope was surfaced, carrying the kind.
        const transient = responses.find((r) => r.type === "TRANSIENT_ERROR");
        expect(transient).toBeDefined();
        if (transient && transient.type === "TRANSIENT_ERROR") {
          expect(transient.scope).toBe("parent");
          expect(transient.kind).toBe(failure.ok ? undefined : failure.kind);
        }
        // No terminal / unauthorized message should ever have been emitted.
        expect(responses.some((r) => r.type === "TERMINAL")).toBe(false);
        expect(responses.some((r) => r.type === "UNAUTHORIZED")).toBe(false);

        // Advance the fake clock by one 3000ms interval: the tracker must retry.
        await vi.advanceTimersByTimeAsync(3000);
        expect(getMessage).toHaveBeenCalledTimes(2);

        // Still polling after the retry.
        expect(tracker.getState()).not.toBe("terminal");
        expect(tracker.getState()).not.toBe("stopped_unauthorized");

        tracker.stop();
      }),
      { numRuns: 100 },
    );
  });
});
