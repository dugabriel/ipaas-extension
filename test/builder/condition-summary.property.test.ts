// Feature: ipaas-helper-extension, Property 11: Condition-summary completeness
//
// Property statement: For any Flow, summarizeConditions returns exactly one
// summary per CONDITION activity, each carrying the activity's conditionType
// and, for each entry in configurations.conditions[], the input, operation, and
// the booleanOperator joining it to the next clause (null for the last); a
// condition with an empty conditions[] array yields a summary flagged as having
// no defined clauses.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { summarizeConditions } from "../../src/builder/builder-helpers";
import type { ConditionClauseRaw, Flow, FlowActivity } from "../../src/models";

// A raw condition clause: input/operation always present; booleanOperator
// optionally present (sometimes undefined to exercise the ?? null fallback).
const clauseRaw: fc.Arbitrary<ConditionClauseRaw> = fc.record({
  input: fc.string(),
  operation: fc.string(),
  booleanOperator: fc.option(fc.string(), { nil: undefined }),
});

// A CONDITION activity: carries a conditionType and a conditions[] array that
// may be empty (to exercise the "no defined clauses" branch, Req 7.4).
const conditionActivity: fc.Arbitrary<FlowActivity> = fc.record({
  type: fc.constant("CONDITION"),
  configurations: fc.record({
    conditionType: fc.string(),
    conditions: fc.array(clauseRaw, { maxLength: 5 }),
  }),
});

// A non-CONDITION activity: any type other than CONDITION. These must be
// ignored by summarizeConditions.
const nonConditionActivity: fc.Arbitrary<FlowActivity> = fc.record({
  type: fc.string({ minLength: 1 }).filter((t) => t !== "CONDITION"),
  ownerTenantName: fc.option(fc.string(), { nil: undefined }),
});

// A Flow whose activities map is a mix of CONDITION and non-CONDITION
// activities under unique keys. We generate activities as a list of
// [key, activity] pairs with distinct keys, then fold them into the record so
// insertion order is preserved for comparison.
const flow: fc.Arbitrary<Flow> = fc
  .uniqueArray(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 8 })
  .chain((keys) =>
    fc
      .tuple(...keys.map(() => fc.oneof(conditionActivity, nonConditionActivity)))
      .map((activityList) => {
        const activities: Record<string, FlowActivity> = {};
        keys.forEach((key, i) => {
          activities[key] = activityList[i] as FlowActivity;
        });
        return {
          async: false,
          functions: {},
          activities,
          start: "",
        } as Flow;
      }),
  );

describe("Feature: ipaas-helper-extension, Property 11: Condition-summary completeness", () => {
  it("returns exactly one summary per CONDITION activity with carried-through type and clauses", () => {
    fc.assert(
      fc.property(flow, (f) => {
        const summaries = summarizeConditions(f);

        const conditionEntries = Object.entries(f.activities).filter(
          ([, a]) => a.type === "CONDITION",
        );

        // Exactly one summary per CONDITION activity; non-CONDITION ignored.
        expect(summaries.length).toBe(conditionEntries.length);

        // Each summary's activityId maps back to a CONDITION activity, with no
        // duplicates.
        const summaryIds = summaries.map((s) => s.activityId);
        const conditionIds = conditionEntries.map(([id]) => id);
        expect(new Set(summaryIds).size).toBe(summaryIds.length);
        expect(new Set(summaryIds)).toEqual(new Set(conditionIds));

        for (const summary of summaries) {
          const activity = f.activities[summary.activityId];
          const config = activity.configurations!;
          const rawClauses = config.conditions;

          // conditionType carried through (Req 7.3).
          expect(summary.conditionType).toBe(config.conditionType);

          // One clause per conditions[] entry (Req 7.2).
          expect(summary.clauses.length).toBe(rawClauses.length);

          // hasClauses reflects whether there are any clauses (Req 7.4).
          expect(summary.hasClauses).toBe(rawClauses.length > 0);

          rawClauses.forEach((raw, index) => {
            const clause = summary.clauses[index];
            // input/operation carried through per entry (Req 7.2).
            expect(clause.input).toBe(raw.input);
            expect(clause.operation).toBe(raw.operation);

            // booleanOperator joins a clause to the NEXT clause: null for the
            // last clause, otherwise the source value (null when absent).
            if (index === rawClauses.length - 1) {
              expect(clause.booleanOperator).toBeNull();
            } else {
              expect(clause.booleanOperator).toBe(raw.booleanOperator ?? null);
            }
          });
        }
      }),
      { numRuns: 100 },
    );
  });
});
