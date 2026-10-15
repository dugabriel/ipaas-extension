import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ExecutionTracker,
  type TrackerApi,
} from "../../src/tracking/execution-tracker";
import type { ApiResult, PortResponse } from "../../src/messaging/protocol";
import type { ExecutionStep, Message, MessageStatus } from "../../src/models";

// Unit tests for the ExecutionTracker polling cadence (Task 12.6).
// Drives the 3-second interval with fake timers and asserts the per-tick
// UPDATE payload and the TERMINAL hand-off.
// Requirements: 12.1, 12.2

const INTERVAL_MS = 3000;

function makeMessage(status: MessageStatus): Message {
  return {
    id: "msg-1",
    integrationId: "int-1",
    diagramId: "dia-1",
    diagramName: "Diagram One",
    status,
    executionTime: 1234,
    initialComponent: "webhook-start",
    finalComponent: "http-end",
    sourceType: "ORIGINAL",
    totalSplitMessage: 0,
    message: undefined,
  };
}

const okSteps: ApiResult<ExecutionStep[]> = { ok: true, data: [] };
const okChildren: ApiResult<{ items: Message[]; total: number }> = {
  ok: true,
  data: { items: [], total: 0 },
};

/**
 * Builds a TrackerApi whose `getMessage` returns the status for each successive
 * call (the last entry repeats once exhausted). `getSteps`/`getChildMessages`
 * return empty ok results so the test isolates the parent cadence.
 */
function makeApi(statuses: MessageStatus[]): {
  api: TrackerApi;
  getMessage: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const getMessage = vi.fn(async (): Promise<ApiResult<Message>> => {
    const idx = Math.min(call, statuses.length - 1);
    call++;
    return { ok: true, data: makeMessage(statuses[idx]) };
  });
  const api: TrackerApi = {
    getMessage,
    getSteps: vi.fn(async () => okSteps),
    getChildMessages: vi.fn(async () => okChildren),
  };
  return { api, getMessage };
}

function makeSink(): {
  sink: { postMessage: (r: PortResponse) => void };
  responses: PortResponse[];
} {
  const responses: PortResponse[] = [];
  return {
    sink: { postMessage: (r: PortResponse) => responses.push(r) },
    responses,
  };
}

describe("ExecutionTracker cadence (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls getMessage on start and again after each 3000ms tick while non-terminal (Req 12.1)", async () => {
    // Parent stays PROCESSING, so polling never stops on its own.
    const { api, getMessage } = makeApi(["PROCESSING"]);
    const { sink } = makeSink();
    const tracker = new ExecutionTracker({ api, sink });

    tracker.start("msg-1", "int-1");
    // The immediate first tick is async; flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(getMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(getMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(getMessage).toHaveBeenCalledTimes(3);

    tracker.stop();
  });

  it("streams an UPDATE carrying status/executionTime/initialComponent/finalComponent from the parent (Req 12.2)", async () => {
    const { api } = makeApi(["PROCESSING"]);
    const { sink, responses } = makeSink();
    const tracker = new ExecutionTracker({ api, sink });

    tracker.start("msg-1", "int-1");
    await vi.advanceTimersByTimeAsync(0);

    const update = responses.find((r) => r.type === "UPDATE");
    expect(update).toBeDefined();
    expect(update).toMatchObject({
      type: "UPDATE",
      status: "PROCESSING",
      executionTime: 1234,
      initialComponent: "webhook-start",
      finalComponent: "http-end",
    });

    tracker.stop();
  });

  it("stops polling and emits a TERMINAL message once the parent is terminal with no children (Req 12.1)", async () => {
    // First tick PROCESSING, second tick DONE (terminal, no children).
    const { api, getMessage } = makeApi(["PROCESSING", "DONE"]);
    const { sink, responses } = makeSink();
    const tracker = new ExecutionTracker({ api, sink });

    tracker.start("msg-1", "int-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(getMessage).toHaveBeenCalledTimes(1);

    // Second tick observes DONE -> terminal, timer cleared.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(getMessage).toHaveBeenCalledTimes(2);

    const terminal = responses.find((r) => r.type === "TERMINAL");
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ type: "TERMINAL", status: "DONE" });
    expect(tracker.getState()).toBe("terminal");

    // No further polling after the terminal tick.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(getMessage).toHaveBeenCalledTimes(2);
  });
});
