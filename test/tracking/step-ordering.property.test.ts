import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { orderSteps, isStepError } from "../../src/tracking/execution-tracker";
import type { ExecutionStep, StepStatus } from "../../src/models";

// Feature: ipaas-helper-extension, Property 15: Step ordering and error indication
// Validates: Requirements 13.2, 13.3
//
// For any array of Execution_Steps, the rendered steps appear in the same order
// as returned (orderSteps preserves order element-for-element and never mutates
// the source), each carrying its activityLabel/status/startDate/endDate; and a
// step is marked with the error indicator iff its status is ERROR — distinct
// from DONE, PROCESSING, and REPROCESSED (isStepError).

const STEP_STATUSES: StepStatus[] = ["PROCESSING", "DONE", "ERROR", "REPROCESSED"];

/** Generator for a single ExecutionStep across the full status space. */
const stepArb: fc.Arbitrary<ExecutionStep> = fc.record(
  {
    messageId: fc.string(),
    componentId: fc.string(),
    activityLabel: fc.string(),
    status: fc.constantFrom(...STEP_STATUSES),
    startDate: fc.string(),
    endDate: fc.option(fc.string(), { nil: undefined }),
  },
  { requiredKeys: ["messageId", "componentId", "activityLabel", "status", "startDate"] },
);

const stepsArb: fc.Arbitrary<ExecutionStep[]> = fc.array(stepArb);

describe("Property 15: Step ordering and error indication", () => {
  it("orderSteps preserves the returned order element-for-element (Req 13.2)", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const ordered = orderSteps(steps);

        expect(ordered).toHaveLength(steps.length);
        for (let i = 0; i < steps.length; i++) {
          // Same reference, same position: order preserved verbatim with each
          // step's activityLabel/status/startDate/endDate intact.
          expect(ordered[i]).toBe(steps[i]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("orderSteps does not mutate its input array (Req 13.2)", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const snapshot = [...steps];

        const ordered = orderSteps(steps);

        // Source is untouched (shallow copy returned)...
        expect(steps).toEqual(snapshot);
        // ...and mutating the result must not reach back into the source.
        ordered.reverse();
        expect(steps).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  it("isStepError is true iff status is ERROR, distinct from DONE/PROCESSING/REPROCESSED (Req 13.3)", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        for (const step of steps) {
          expect(isStepError(step)).toBe(step.status === "ERROR");
        }
      }),
      { numRuns: 100 },
    );
  });
});
