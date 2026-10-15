// Feature: ipaas-helper-extension, Property 12: Execute-button precondition
//
// Property statement: For any Integration, shouldShowExecuteButton returns true
// iff the Start_Activity resolved from flow.start is a WEBHOOK trigger (sync or
// async) AND integration.active is true AND integration.status equals
// "PUBLISHED".
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { shouldShowExecuteButton } from "../../src/builder/builder-helpers";
import type { Flow, FlowActivity, Integration } from "../../src/models";

// Candidate activity types: WEBHOOK qualifies as a trigger; the others do not.
// We mix in some non-WEBHOOK types so the oracle gets exercised on both sides.
const activityType: fc.Arbitrary<string> = fc.constantFrom(
  "WEBHOOK",
  "CONDITION",
  "FUNCTION_JOLT",
  "SCHEDULER",
  "HTTP",
);

// A single activity carrying only its type (the only field the precondition
// inspects). sync vs async is a Flow-level concern (flow.async), so the start
// activity's WEBHOOK-ness is independent of sync/async — see the flow arbitrary.
const activity: fc.Arbitrary<FlowActivity> = activityType.map((type) => ({ type }));

// A Flow whose activities map is keyed by generated ids, and whose `start`
// points at one of those keys, a missing key, or an empty string. This lets the
// generator produce flows where flow.start resolves to a WEBHOOK, to a
// non-WEBHOOK, or to no activity at all.
const flow: fc.Arbitrary<Flow> = fc
  .uniqueArray(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 6 })
  .chain((keys) =>
    fc
      .tuple(
        fc.tuple(...keys.map(() => activity)),
        // start resolves to an existing key, a non-existent key, or "".
        keys.length > 0
          ? fc.oneof(fc.constantFrom(...keys), fc.string(), fc.constant(""))
          : fc.oneof(fc.string(), fc.constant("")),
        // flow.async is independent of whether the start activity is a WEBHOOK;
        // both sync (false) and async (true) webhooks must qualify (Req 8.2).
        fc.boolean(),
      )
      .map(([activityList, start, async]) => {
        const activities: Record<string, FlowActivity> = {};
        keys.forEach((key, i) => {
          activities[key] = activityList[i] as FlowActivity;
        });
        return { async, functions: {}, activities, start } as Flow;
      }),
  );

// An Integration varying active (true/false), status (PUBLISHED vs others), and
// the flow (whose start may or may not resolve to a WEBHOOK).
const integration: fc.Arbitrary<Integration> = fc.record({
  id: fc.string(),
  name: fc.string(),
  active: fc.boolean(),
  status: fc.constantFrom("PUBLISHED", "DRAFT", "INACTIVE", "ARCHIVED", ""),
  flow,
});

// Independent oracle: true iff the activity at flow.start is a WEBHOOK AND
// active is true AND status is exactly "PUBLISHED".
function oracle(i: Integration): boolean {
  const startActivity = i.flow.activities[i.flow.start];
  const isWebhookStart = startActivity?.type === "WEBHOOK";
  return isWebhookStart && i.active === true && i.status === "PUBLISHED";
}

describe("Feature: ipaas-helper-extension, Property 12: Execute-button precondition", () => {
  it("returns true iff start activity is WEBHOOK AND active AND status PUBLISHED", () => {
    fc.assert(
      fc.property(integration, (i) => {
        expect(shouldShowExecuteButton(i)).toBe(oracle(i));
      }),
      { numRuns: 100 },
    );
  });

  it("qualifies both sync and async webhooks when active and PUBLISHED (Req 8.2)", () => {
    // Pin the qualifying conditions and vary only flow.async to assert the
    // WEBHOOK trigger check is independent of sync/async.
    fc.assert(
      fc.property(fc.boolean(), (async) => {
        const i: Integration = {
          id: "int-1",
          name: "webhook integration",
          active: true,
          status: "PUBLISHED",
          flow: {
            async,
            functions: {},
            activities: { s: { type: "WEBHOOK" } },
            start: "s",
          },
        };
        expect(shouldShowExecuteButton(i)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
