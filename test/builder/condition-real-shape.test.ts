import { describe, it, expect } from "vitest";
import { summarizeConditions } from "../../src/builder/builder-helpers";
import type { Flow } from "../../src/models";

// Feature: ipaas-helper-extension — condition summary against the real flow shape
// (conditions is an array-of-arrays, each clause has input/expected/operation/
// booleanOperator), validating that input/operation/expected and the label show.

describe("summarizeConditions — real nested shape", () => {
  it("flattens conditions[][] and surfaces input/operation/expected + label", () => {
    const flow = {
      async: false,
      functions: {},
      start: "trigger",
      activities: {
        "trigger#id6": {
          type: "CONDITION",
          label: "When-ERP-Customer",
          configurations: {
            conditionType: "simple",
            conditions: [
              [
                {
                  input: "{{{trigger.Header.Transaction}}}",
                  expected: "CUSTOMER",
                  operation: "EQUALS",
                  booleanOperator: "&&",
                },
              ],
            ],
          },
        },
      },
    } as unknown as Flow;

    const [summary] = summarizeConditions(flow);
    expect(summary.label).toBe("When-ERP-Customer");
    expect(summary.conditionType).toBe("simple");
    expect(summary.hasClauses).toBe(true);
    expect(summary.clauses).toHaveLength(1);
    expect(summary.clauses[0]).toEqual({
      input: "{{{trigger.Header.Transaction}}}",
      operation: "EQUALS",
      expected: "CUSTOMER",
      booleanOperator: null, // last (and only) clause
    });
  });
});
