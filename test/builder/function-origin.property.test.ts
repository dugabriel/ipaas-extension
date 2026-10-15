// Feature: ipaas-helper-extension, Property 10: Function-origin resolution completeness
//
// Property statement: For any Flow, resolveFunctionOrigins returns exactly one
// entry per flow.functions function. The origin and the highlight target come
// from the activity that CONSUMES the function (the activity whose
// configuration references `{{{function.<functionId>.output}}}`); when no
// activity consumes it, originApp and activityId are null. One function never
// affects another's resolution.
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveFunctionOrigins } from "../../src/builder/builder-helpers";
import type { Flow, FlowActivity, FlowFunction } from "../../src/models";

// A function id pool so references hit/miss deterministically.
const fnIds = ["id1", "id2", "id3", "id4", "id5"];

/** Builds a flow where some activities consume some functions via output refs. */
const flowArb: fc.Arbitrary<{ flow: Flow; consumedBy: Record<string, string> }> =
  fc
    .uniqueArray(fc.constantFrom(...fnIds), { minLength: 0, maxLength: 5 })
    .chain((functionIds) =>
      fc
        .tuple(
          // For each function, decide if an activity consumes it (and that
          // activity's app name).
          fc.tuple(
            ...functionIds.map(() =>
              fc.option(fc.constantFrom("TOTVS HUB CRM", "Webhook.site", "ERP"), {
                nil: undefined,
              }),
            ),
          ),
        )
        .map(([apps]) => {
          const functions: Record<string, FlowFunction> = {};
          for (const fid of functionIds) {
            functions[fid] = {
              id: fid,
              name: `fn-${fid}`,
              type: "FUNCTION_JOLT",
              label: `fn-${fid}`,
              componentId: "shared-component",
              componentResourceId: "shared-resource",
            } as FlowFunction;
          }
          const activities: Record<string, FlowActivity> = {};
          const consumedBy: Record<string, string> = {};
          functionIds.forEach((fid, i) => {
            const app = apps[i];
            if (app) {
              const actKey = `act-${fid}`;
              activities[actKey] = {
                type: "REST",
                name: app,
                label: `POST-${fid}`,
                configurations: { inBody: `{{{function.${fid}.output}}}` },
              } as unknown as FlowActivity;
              consumedBy[fid] = actKey;
            }
          });
          return {
            flow: { async: false, functions, activities, start: "" } as Flow,
            consumedBy,
          };
        }),
    );

describe("Feature: ipaas-helper-extension, Property 10: Function-origin resolution completeness", () => {
  it("returns one entry per function; origin/activityId come from the consuming activity", () => {
    fc.assert(
      fc.property(flowArb, ({ flow, consumedBy }) => {
        const result = resolveFunctionOrigins(flow);
        const fnKeys = Object.keys(flow.functions);

        // Exactly one entry per function.
        expect(result).toHaveLength(fnKeys.length);

        for (const entry of result) {
          const expectedActivity = consumedBy[entry.functionId];
          if (expectedActivity) {
            // Consumed -> activityId points at the consuming activity, origin set.
            expect(entry.activityId).toBe(expectedActivity);
            expect(entry.originApp).not.toBeNull();
          } else {
            // Not consumed -> no origin, no highlight target.
            expect(entry.activityId).toBeNull();
            expect(entry.originApp).toBeNull();
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
