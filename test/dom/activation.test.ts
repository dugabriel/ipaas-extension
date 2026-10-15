// Integration/DOM test for builder activation (Task 7.4).
//
// Exercises the `activate()` export from src/content.ts end-to-end against jsdom
// with the global sinon-chrome mock:
//  - on a `/builder/{id}` path the extension root container is created and marked
//    active after the awaited GET_FLOW message resolves with an Integration
//    (Req 1.1); the awaited render completes well within the 2s activation budget;
//  - on a non-builder path no activation occurs: the container is never created
//    and no GET_FLOW message is sent (Req 1.2).
//
// Requirements: 1.1, 1.2
import { describe, it, expect, beforeEach } from "vitest";
import { activate } from "../../src/content";
import type { Integration } from "../../src/models";
import type { GetFlowRequest } from "../../src/messaging/protocol";

const CONTAINER_ID = "ipaas-helper-root";

// The sinon-chrome stub surface for chrome.runtime.sendMessage, read live each
// call (sinon-chrome ships without types; mirrors test/auth/cookie-read.test.ts).
interface SendMessageStub {
  resolves(value: unknown): void;
  calledOnce: boolean;
  notCalled: boolean;
  firstCall: { args: unknown[] };
  getCalls(): Array<{ args: unknown[] }>;
}

function sendMessage(): SendMessageStub {
  return chrome.runtime.sendMessage as unknown as SendMessageStub;
}

// A minimal, valid Integration the worker returns for the builder path.
function makeIntegration(): Integration {
  return {
    id: "integration-1",
    name: "My Integration",
    active: true,
    status: "PUBLISHED",
    flow: {
      async: false,
      functions: {},
      activities: {},
      start: "start-activity",
    },
  };
}

// Point jsdom's window.location at the given path. history.replaceState keeps
// location.pathname (which content.ts reads) in sync without a real navigation.
function setPath(path: string): void {
  window.history.replaceState({}, "", path);
}

describe("builder content-script activation (DOM)", () => {
  beforeEach(() => {
    // Clean DOM between tests so container creation is observable per case.
    document.body.innerHTML = "";
    setPath("/");
  });

  it("activates on /builder/{id} after the flow loads (Req 1.1)", async () => {
    const diagramId = "diagram-123";
    setPath(`/builder/${diagramId}`);

    // Stub the worker round-trip: GET_FLOW resolves to an Integration result.
    sendMessage().resolves({ ok: true, data: makeIntegration() });

    const start = Date.now();
    await activate();
    const elapsedMs = Date.now() - start;

    // Within the 2s activation budget (Req 1.1).
    expect(elapsedMs).toBeLessThan(2000);

    const container = document.getElementById(CONTAINER_ID);
    expect(container).not.toBeNull();
    expect(container?.dataset.active).toBe("true");
    expect(container?.dataset.reason).toBeUndefined();

    // The flow was requested for the path's diagram id (Req 1.1 / 5.2). The
    // content script first captures the token (STORE_TOKEN) and then sends
    // GET_FLOW, so we look for the GET_FLOW message among the calls.
    const calls = sendMessage().getCalls();
    const flowCall = calls
      .map((c) => c.args[0] as { type?: string; diagramId?: string })
      .find((m) => m?.type === "GET_FLOW");
    expect(flowCall).toBeDefined();
    expect(flowCall?.diagramId).toBe(diagramId);
  });

  it("stays inactive on a non-builder path (Req 1.2)", async () => {
    setPath("/dashboard");

    sendMessage().resolves({ ok: true, data: makeIntegration() });

    await activate();

    // No container created and no flow request made on a non-builder path.
    expect(document.getElementById(CONTAINER_ID)).toBeNull();
    expect(sendMessage().notCalled).toBe(true);
  });
});
