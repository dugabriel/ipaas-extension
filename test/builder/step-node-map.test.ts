import { describe, it, expect } from "vitest";
import {
  buildStepNodeIndex,
  resolveStepNodeId,
} from "../../src/builder/builder-helpers";
import type { Flow } from "../../src/models";

// Mapping verified against the real "gerenciador api" flow (diagram
// 6eabe391-...): the Steps_API labels line up with the flow activity labels,
// whose map keys are the canvas DOM node ids. A step's componentId is the
// service UUID (shared across nodes) and must NOT be used as the node id.
const flow = {
  start: "webhook-hook-trigger",
  functions: {},
  activities: {
    id3: { type: "REST", label: "get all pets", componentId: "67360832-cbcc-4973-b48d-1fede9b23a66" },
    "id-splitter2": {
      type: "SPLIT",
      label: "split 10",
      configurations: {
        subFlow: {
          activities: {
            "id-generator5": { type: "GENERATOR", label: "ggg", serviceId: "b88804ef-b3b9-4920-8b18-c23dbf0b2ffc" },
            "splitter-start2": { type: "SPLIT_START", label: "Splitter Start" },
          },
        },
      },
    },
    "id-generator1": { type: "GENERATOR", label: "gerenciador api", serviceId: "b88804ef-b3b9-4920-8b18-c23dbf0b2ffc" },
    "id-javascript4": { type: "JAVASCRIPT", label: "get 10", serviceId: "78f4d43e-fae4-4849-9c01-57373eed74b4" },
    "webhook-hook-trigger": { type: "WEBHOOK", label: "Webhook", componentResourceId: "webhook-hook-trigger" },
  },
} as unknown as Flow;

describe("step -> canvas node id mapping (real flow)", () => {
  const index = buildStepNodeIndex(flow);

  it("resolves each step by activityLabel to the activity key (DOM id)", () => {
    expect(resolveStepNodeId({ activityLabel: "Webhook" }, index)).toBe("webhook-hook-trigger");
    expect(resolveStepNodeId({ activityLabel: "gerenciador api" }, index)).toBe("id-generator1");
    expect(resolveStepNodeId({ activityLabel: "get all pets" }, index)).toBe("id3");
    expect(resolveStepNodeId({ activityLabel: "get 10" }, index)).toBe("id-javascript4");
    expect(resolveStepNodeId({ activityLabel: "split 10" }, index)).toBe("id-splitter2");
  });

  it("does not use the shared service componentId as the node id", () => {
    // Two activities share serviceId b88804ef...; a step must still land on the
    // right node via its label, not the shared id.
    expect(
      resolveStepNodeId(
        { componentId: "b88804ef-b3b9-4920-8b18-c23dbf0b2ffc", activityLabel: "gerenciador api" },
        index,
      ),
    ).toBe("id-generator1");
  });

  it("resolves a trigger whose componentId equals its canvas key", () => {
    expect(
      resolveStepNodeId({ componentId: "webhook-hook-trigger", activityLabel: "" }, index),
    ).toBe("webhook-hook-trigger");
  });

  it("resolves nested splitter sub-flow activities by label", () => {
    expect(resolveStepNodeId({ activityLabel: "ggg" }, index)).toBe("id-generator5");
  });

  it("prefers inHeaders.activityId as the canonical DOM node key", () => {
    // Real steps carry inHeaders.activityId equal to the DOM key, even when the
    // componentId is a shared service UUID.
    expect(
      resolveStepNodeId(
        {
          componentId: "b88804ef-b3b9-4920-8b18-c23dbf0b2ffc",
          activityLabel: "whatever",
          inHeaders: { activityId: "id-generator1" },
        },
        index,
      ),
    ).toBe("id-generator1");
    expect(
      resolveStepNodeId(
        { activityLabel: "x", inHeaders: { activityId: "id-generator6" } },
        buildStepNodeIndex({
          start: "a",
          functions: {},
          activities: { "id-generator6": { type: "GENERATOR", label: "teste" } },
        } as unknown as Flow),
      ),
    ).toBe("id-generator6");
  });

  it("resolves a CONDITION step by label when it has no activityId header", () => {
    const condFlow = {
      start: "a",
      functions: {},
      activities: {
        "id-javascript4#id-generator6": { type: "CONDITION", label: "t" },
      },
    } as unknown as Flow;
    const condIndex = buildStepNodeIndex(condFlow);
    expect(
      resolveStepNodeId(
        {
          componentId: "98405216-83c8-468d-9c53-73d4694143f8",
          activityLabel: "t",
          inHeaders: {},
        },
        condIndex,
      ),
    ).toBe("id-javascript4#id-generator6");
  });

  it("returns null when nothing resolves (highlighter skips the step)", () => {
    expect(resolveStepNodeId({ activityLabel: "nope", componentId: "nope" }, index)).toBeNull();
  });
});
