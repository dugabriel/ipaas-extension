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
    expect(cond?.inGlobalError).toBe(false);
    expect(cond?.subflowOrigin).toBe("splitter");
  });
});

describe("subflow traversal (global-error sub-flow)", () => {
  // Mirrors the real captured shape: the GLOBAL_ERROR marker in the main flow
  // carries EMPTY configurations, and the actual sub-flow lives at the TOP
  // LEVEL in flow.globalErrorFlow. A Generator inside it references
  // {{{function.id15.date}}} (resolving against the MAIN flow.functions), and a
  // CONDITION also lives inside the sub-flow. Functions/conditions nested there
  // must be flattened and surfaced exactly like splitter items, but tagged with
  // a DISTINCT origin.
  const flow = {
    async: false,
    start: "trigger3",
    functions: {
      id15: { id: "id15", name: "format date", type: "FUNCTION_DATE_TIME", label: "format date", params: {} },
      id99: { id: "id99", name: "unused fn", type: "FUNCTION_JOLT", label: "unused fn", params: {} },
    },
    activities: {
      trigger3: { type: "WEBHOOK", label: "Webhook" },
      "id-global-error": {
        // Marker activity in the MAIN flow: empty configurations, no sub-flow.
        type: "GLOBAL_ERROR",
        label: "Global error",
        configurations: {},
      },
    },
    globalErrorFlow: {
      start: "global-error-start",
      activities: {
        "global-error-start": { id: "global-error-start", type: "GLOBAL_ERROR_START", label: "Global Error Start" },
        "id-generator14": {
          id: "id-generator14",
          type: "GENERATOR",
          name: "Dados Erro",
          label: "Dados Erro",
          configurations: { name: "Dados Erro", fileContent: "{{{function.id15.date}}}" },
        },
        "global-error-start#id-cond": {
          id: "global-error-start#id-cond",
          type: "CONDITION",
          label: "Erro Fatal",
          connections: { next: ["id16"] },
          configurations: {
            conditionType: "simple",
            conditions: [[{ input: "{{{global-error-start.code}}}", expected: "500", operation: "EQUALS", booleanOperator: "&&" }]],
          },
        },
      },
    },
  } as unknown as Flow;

  it("classifies a function consumed inside the global-error sub-flow as 'node' with a distinct origin", () => {
    const origins = resolveFunctionOrigins(flow);
    const byId = Object.fromEntries(origins.map((e) => [e.functionId, e]));

    expect(byId.id15.usage).toBe("node");
    expect(byId.id15.activityId).toBe("id-generator14");
    // Surfaced like a sub-flow item, but tagged distinctly from a splitter.
    expect(byId.id15.inGlobalError).toBe(true);
    expect(byId.id15.inSplitter).toBe(false);
    expect(byId.id15.subflowOrigin).toBe("global-error");

    expect(byId.id99.usage).toBe("unused");
    expect(byId.id99.inGlobalError).toBe(false);
    expect(byId.id99.subflowOrigin).toBe("none");
  });

  it("summarizes a CONDITION that lives inside the global-error sub-flow with a distinct origin", () => {
    const summaries = summarizeConditions(flow);
    const cond = summaries.find((c) => c.activityId === "global-error-start#id-cond");
    expect(cond).toBeDefined();
    expect(cond?.clauses[0]?.expected).toBe("500");
    expect(cond?.targetId).toBe("id16");
    expect(cond?.inGlobalError).toBe(true);
    expect(cond?.inSplitter).toBe(false);
    expect(cond?.subflowOrigin).toBe("global-error");
  });
});
