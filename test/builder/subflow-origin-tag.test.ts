import { describe, it, expect } from "vitest";
import {
  renderFunctionOrigins,
  renderConditionSummaries,
  type FunctionOrigin,
  type ConditionSummary,
} from "../../src/builder/builder-helpers";

// The data is generalized (splitter + global-error flattened the same way) but
// the UI must keep the origin visible and DISTINCT: a splitter item renders the
// splitter tag, a global-error item renders a separate "global error" tag, and
// a root item renders neither. The two must never collapse into one tag.

function originFixture(partial: Partial<FunctionOrigin>): FunctionOrigin {
  return {
    functionId: "f",
    functionName: "fn",
    originApp: "App",
    activityId: "a",
    usage: "node",
    usedBy: null,
    inSplitter: false,
    inGlobalError: false,
    subflowOrigin: "none",
    ...partial,
  };
}

function conditionFixture(partial: Partial<ConditionSummary>): ConditionSummary {
  return {
    activityId: "a",
    label: "Cond",
    conditionType: "simple",
    clauses: [{ input: "x", operation: "EQUALS", expected: "y", booleanOperator: null }],
    hasClauses: true,
    targetId: "n",
    isElse: false,
    inSplitter: false,
    inGlobalError: false,
    subflowOrigin: "none",
    ...partial,
  };
}

describe("renderFunctionOrigins — distinct sub-flow origin tags", () => {
  it("renders a distinct tag per origin (splitter vs global error vs none)", () => {
    const el = renderFunctionOrigins([
      originFixture({ functionId: "f-split", subflowOrigin: "splitter", inSplitter: true }),
      originFixture({ functionId: "f-ge", subflowOrigin: "global-error", inGlobalError: true }),
      originFixture({ functionId: "f-root", subflowOrigin: "none" }),
    ]);

    const splitterTags = el.querySelectorAll(".ipaas-helper-splitter-tag");
    const globalErrorTags = el.querySelectorAll(".ipaas-helper-global-error-tag");

    expect(splitterTags).toHaveLength(1);
    expect(globalErrorTags).toHaveLength(1);
    // Global-error item is NOT shown as a splitter item, and vice versa.
    expect(splitterTags[0].textContent).toBe("splitter");
    expect(globalErrorTags[0].textContent).toBe("global error");
  });
});

describe("renderConditionSummaries — distinct sub-flow origin tags", () => {
  it("renders a distinct tag per origin (splitter vs global error vs none)", () => {
    const el = renderConditionSummaries([
      conditionFixture({ activityId: "c-split", subflowOrigin: "splitter", inSplitter: true }),
      conditionFixture({ activityId: "c-ge", subflowOrigin: "global-error", inGlobalError: true }),
      conditionFixture({ activityId: "c-root", subflowOrigin: "none" }),
    ]);

    expect(el.querySelectorAll(".ipaas-helper-splitter-tag")).toHaveLength(1);
    expect(el.querySelectorAll(".ipaas-helper-global-error-tag")).toHaveLength(1);
  });
});
