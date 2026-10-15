import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { aggregateChildren } from "../../src/tracking/execution-tracker";
import type { Message, MessageStatus } from "../../src/models";

// Feature: ipaas-helper-extension, Property 18: Child-message aggregation counts
// Validates: Requirements 14.2
//
// For any list of Child_Messages for a parent with `totalSplitMessage` splits,
// `aggregateChildren` reports the exact counts of children in DONE, ERROR, and
// PROCESSING; those counts sum to the number of observed children whose status
// is one of those three buckets; and `total` is the passed `totalSplitMessage`.
//
// REPROCESSED children are a displayed-status exclusion: the implementation
// counts only DONE/ERROR/PROCESSING, so a REPROCESSED child contributes to none
// of the three buckets. The oracle below mirrors that exactly.

/** The four statuses a Child_Message can carry (src/models.ts MessageStatus). */
const STATUSES: readonly MessageStatus[] = [
  "DONE",
  "ERROR",
  "PROCESSING",
  "REPROCESSED",
];

/**
 * A SPLITTED child Message generator. Only `status` drives aggregation; the
 * remaining fields are filled with representative-but-irrelevant values so the
 * object is a well-formed `Message`.
 */
const childArb: fc.Arbitrary<Message> = fc
  .constantFrom(...STATUSES)
  .map((status) => ({
    id: "child",
    integrationId: "integration",
    diagramId: "diagram",
    diagramName: "diagram-name",
    status,
    executionTime: 0,
    initialComponent: "start",
    finalComponent: "end",
    sourceType: "SPLITTED",
    originMessageId: "parent",
    totalSplitMessage: 0,
  }));

/** Independent oracle: exact per-status counts, REPROCESSED excluded. */
function expectedCounts(children: readonly Message[]): {
  done: number;
  error: number;
  processing: number;
} {
  let done = 0;
  let error = 0;
  let processing = 0;
  for (const child of children) {
    if (child.status === "DONE") done++;
    else if (child.status === "ERROR") error++;
    else if (child.status === "PROCESSING") processing++;
    // REPROCESSED (and anything else) is not a displayed bucket.
  }
  return { done, error, processing };
}

describe("Property 18: Child-message aggregation counts", () => {
  it("reports exact DONE/ERROR/PROCESSING counts that pass through total and sum to displayed children (Req 14.2)", () => {
    fc.assert(
      fc.property(
        fc.array(childArb),
        fc.integer({ min: 0, max: 1000 }),
        (children, total) => {
          const aggregate = aggregateChildren(children, total);
          const expected = expectedCounts(children);

          // `total` is the parent's totalSplitMessage, passed through verbatim.
          expect(aggregate.total).toBe(total);

          // Exact per-status counts of the observed children.
          expect(aggregate.done).toBe(expected.done);
          expect(aggregate.error).toBe(expected.error);
          expect(aggregate.processing).toBe(expected.processing);

          // The three displayed buckets sum to the number of children whose
          // status is one of DONE/ERROR/PROCESSING (REPROCESSED excluded).
          const displayedChildren = children.filter(
            (c) =>
              c.status === "DONE" ||
              c.status === "ERROR" ||
              c.status === "PROCESSING",
          ).length;
          expect(aggregate.done + aggregate.error + aggregate.processing).toBe(
            displayedChildren,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
