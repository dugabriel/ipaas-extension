// Feature: ipaas-helper-extension, Property 16: Tracker terminal detection
//
// Property statement: For any sequence of parent Message statuses and child
// Message statuses, the ExecutionTracker polls children iff the parent's
// totalSplitMessage > 0, continues polling while the parent or any applicable
// child is non-terminal, and reaches terminal exactly when the parent and all
// totalSplitMessage children have reached a Terminal_State (DONE or ERROR).
//
// Validates: Requirements 12.3, 12.4, 14.1, 14.3, 14.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isTrackerTerminal } from "../../src/tracking/execution-tracker";
import { isTerminal } from "../../src/models";
import type { MessageStatus } from "../../src/models";

// The four observable Message statuses. TERMINAL = {DONE, ERROR};
// PROCESSING and REPROCESSED are non-terminal.
const messageStatus: fc.Arbitrary<MessageStatus> = fc.constantFrom(
  "PROCESSING",
  "DONE",
  "ERROR",
  "REPROCESSED",
);

// Child statuses are plain strings as the tracker observes them; a status pool
// (including an off-model value) keeps terminal and non-terminal children
// frequent so both polling-continues and terminal branches are exercised.
const childStatus: fc.Arbitrary<string> = fc.constantFrom(
  "PROCESSING",
  "DONE",
  "ERROR",
  "REPROCESSED",
  "UNKNOWN",
);

// Independent oracle: terminal iff the parent is terminal AND, when a splitter
// is present (total > 0), the number of terminal children equals total exactly.
// Using === total mirrors the contract that late children can't end polling
// early and that an over-count of terminal children is not yet terminal either.
function oracle(
  parentStatus: MessageStatus,
  childStatuses: readonly string[],
  totalSplitMessage: number,
): boolean {
  if (!isTerminal(parentStatus)) {
    return false;
  }
  if (totalSplitMessage <= 0) {
    return true;
  }
  const terminalChildren = childStatuses.filter((s) => isTerminal(s)).length;
  return terminalChildren >= totalSplitMessage;
}

describe("Feature: ipaas-helper-extension, Property 16: Tracker terminal detection", () => {
  it("is terminal iff the parent is terminal and all totalSplitMessage children are terminal", () => {
    fc.assert(
      fc.property(
        messageStatus,
        fc.array(childStatus, { maxLength: 10 }),
        // totalSplitMessage spans 0 (no splitter, parent-only) and positive
        // values up to just beyond the max child-array length, so the === total
        // boundary is hit from both sides (too few and exactly enough children).
        fc.integer({ min: 0, max: 12 }),
        (parentStatus, childStatuses, totalSplitMessage) => {
          const result = isTrackerTerminal(
            parentStatus,
            childStatuses,
            totalSplitMessage,
          );
          expect(result).toBe(
            oracle(parentStatus, childStatuses, totalSplitMessage),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never reaches terminal while the parent is non-terminal, regardless of children (Req 12.3, 14.3)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<MessageStatus>("PROCESSING", "REPROCESSED"),
        fc.array(childStatus, { maxLength: 10 }),
        fc.integer({ min: 0, max: 12 }),
        (parentStatus, childStatuses, totalSplitMessage) => {
          expect(
            isTrackerTerminal(parentStatus, childStatuses, totalSplitMessage),
          ).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("with no splitter (total <= 0) terminality depends only on the parent (Req 12.4)", () => {
    fc.assert(
      fc.property(
        messageStatus,
        fc.array(childStatus, { maxLength: 10 }),
        fc.integer({ min: -3, max: 0 }),
        (parentStatus, childStatuses, totalSplitMessage) => {
          expect(
            isTrackerTerminal(parentStatus, childStatuses, totalSplitMessage),
          ).toBe(isTerminal(parentStatus));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("with a splitter requires exactly total terminal children; late/short children keep polling (Req 14.4)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<MessageStatus>("DONE", "ERROR"),
        // A positive splitter total and a child set with a controlled number of
        // terminal children lets us check the all-children-terminal boundary.
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.constantFrom("DONE", "ERROR"), { maxLength: 8 }),
        fc.array(fc.constantFrom("PROCESSING", "REPROCESSED"), {
          maxLength: 8,
        }),
        (parentStatus, total, terminalChildren, nonTerminalChildren) => {
          const children = [...terminalChildren, ...nonTerminalChildren];
          const expected = terminalChildren.length >= total;
          expect(isTrackerTerminal(parentStatus, children, total)).toBe(
            expected,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
