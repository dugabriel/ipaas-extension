import { describe, it, expect } from "vitest";
import {
  resolveFunctionOrigins,
  summarizeConditions,
} from "../../src/builder/builder-helpers";
import type { Flow } from "../../src/models";

describe("resolveFunctionOrigins — usage categories + sorting", () => {
  it("classifies node / function / unused and sorts unused last", () => {
    const flow = {
      async: false,
      start: "t",
      functions: {
        fUsedByNode: { id: "fUsedByNode", name: "A", type: "FUNCTION_JOLT", label: "A", componentId: "c", componentResourceId: "r" },
        fUsedByFn: { id: "fUsedByFn", name: "B", type: "FUNCTION_JOLT", label: "B", componentId: "c", componentResourceId: "r" },
        fUnused: { id: "fUnused", name: "C", type: "FUNCTION_JOLT", label: "C", componentId: "c", componentResourceId: "r" },
        agg: { id: "agg", name: "Agg", type: "FUNCTION_AGGREGATE", label: "Agg", componentId: "c", componentResourceId: "r", params: { aggregate: { inputs: ["{{{function.fUsedByFn.output}}}"] } } },
      },
      activities: {
        node1: { type: "REST", name: "TOTVS HUB", label: "POST-A", configurations: { inBody: "{{{function.fUsedByNode.output}}}" } },
      },
    } as unknown as Flow;

    const r = resolveFunctionOrigins(flow);
    const byId = Object.fromEntries(r.map((e) => [e.functionId, e]));

    expect(byId.fUsedByNode.usage).toBe("node");
    expect(byId.fUsedByNode.activityId).toBe("node1");
    expect(byId.fUsedByNode.originApp).toContain("TOTVS HUB");

    expect(byId.fUsedByFn.usage).toBe("function");
    expect(byId.fUsedByFn.usedBy).toBe("Agg");

    expect(byId.fUnused.usage).toBe("unused");

    // Unused entries come last.
    const usages = r.map((e) => e.usage);
    const lastUnusedBlockStarts = usages.indexOf("unused");
    expect(usages.slice(lastUnusedBlockStarts).every((u) => u === "unused")).toBe(true);
  });
});

describe("summarizeConditions — else/OTHERWISE", () => {
  it("includes an else entry for OTHERWISE activities", () => {
    const flow = {
      async: false,
      start: "t",
      functions: {},
      activities: {
        cond: {
          type: "CONDITION",
          label: "When-X",
          connections: { next: ["n1"] },
          configurations: { conditionType: "simple", conditions: [[{ input: "a", expected: "b", operation: "EQUALS", booleanOperator: "&&" }]] },
        },
        els: {
          type: "OTHERWISE",
          label: "Otherwise",
          connections: { next: ["n2"] },
        },
      },
    } as unknown as Flow;

    const summaries = summarizeConditions(flow);
    const elseSummary = summaries.find((s) => s.isElse);
    expect(elseSummary).toBeDefined();
    expect(elseSummary?.conditionType).toBe("else");
    expect(elseSummary?.targetId).toBe("n2");
    const normal = summaries.find((s) => !s.isElse);
    expect(normal?.clauses[0].expected).toBe("b");
  });
});
