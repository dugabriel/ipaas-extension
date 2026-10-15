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

describe("subflow traversal (splitter sub-flow)", () => {
  // Mirrors the real "gerenciador api" flow: function id11 is consumed by a
  // Diagram Caller INSIDE the splitter sub-flow via {{{function.id11.division}}};
  // id9 is unused. A CONDITION also lives inside the sub-flow.
  const flow = {
    start: "webhook-hook-trigger",
    functions: {
      id9: { id: "id9", name: "add date", type: "FUNCTION_DATE_TIME_ADD", label: "add date", params: {} },
      id11: { id: "id11", name: "division", type: "FUNCTION_DIVISION", label: "division", params: {} },
    },
    activities: {
      "id-splitter2": {
        type: "SPLIT",
        label: "split 10",
        configurations: {
          subFlow: {
            start: "splitter-start2",
            activities: {
              "id-diagram-caller10": {
                type: "DIAGRAM_CALLER",
                name: "Diagram Caller",
                label: "zap",
                configurations: { body: "{{{function.id11.division}}}", name: "zap" },
              },
              "id-generator5#id-diagram-caller10": {
                type: "CONDITION",
                label: "1=1 eee",
                configurations: {
                  conditionType: "simple",
                  conditions: [[{ input: "1", expected: "1", operation: "EQUALS", booleanOperator: "&&" }]],
                },
                connections: { next: ["id-diagram-caller10"] },
              },
            },
          },
        },
      },
    },
  } as unknown as Flow;

  it("classifies a function consumed inside a splitter sub-flow as 'node'", () => {
    const origins = resolveFunctionOrigins(flow);
    const byId = Object.fromEntries(origins.map((e) => [e.functionId, e]));
    expect(byId.id11.usage).toBe("node");
    expect(byId.id11.activityId).toBe("id-diagram-caller10");
    expect(byId.id11.inSplitter).toBe(true);
    expect(byId.id9.usage).toBe("unused");
    expect(byId.id9.inSplitter).toBe(false);
  });

  it("summarizes a CONDITION that lives inside a splitter sub-flow", () => {
    const summaries = summarizeConditions(flow);
    const cond = summaries.find((c) => c.activityId === "id-generator5#id-diagram-caller10");
    expect(cond).toBeDefined();
    expect(cond?.clauses[0]?.expected).toBe("1");
    expect(cond?.targetId).toBe("id-diagram-caller10");
    expect(cond?.inSplitter).toBe(true);
  });
});
