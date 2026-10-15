// Feature: ipaas-helper-extension, Property 13: Execution-key selection
//
// Property statement: For any list of Execution_Keys and current Integration,
// the selector returns the key whose integrationId equals the Integration id OR
// whose diagram.id equals the current Diagram_Id, and returns none when no key
// matches; a selected key exposes its apiKey, sync, and noContent.
//
// Validates: Requirements 9.2, 9.3
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { selectExecutionKey } from "../../src/builder/key-selection";
import type { SelectedKey } from "../../src/builder/key-selection";
import type { ExecutionKey } from "../../src/models";

// A small id pool keeps collisions between a key's integrationId/diagram.id and
// the queried integrationId/diagramId frequent, so the generator exercises both
// the match and no-match branches rather than almost always missing.
const id: fc.Arbitrary<string> = fc.constantFrom(
  "a",
  "b",
  "c",
  "d",
  "e",
  "",
);

// An ExecutionKey carrying all the fields `selectExecutionKey` reads
// (integrationId, diagram.id) plus the fields it exposes (apiKey, sync,
// noContent). Other model fields are filled with inert values.
const executionKey: fc.Arbitrary<ExecutionKey> = fc.record({
  id: fc.string(),
  integrationId: id,
  apiKey: fc.string(),
  eai: fc.boolean(),
  noContent: fc.boolean(),
  sync: fc.boolean(),
  diagram: fc.record({ id: id, name: fc.string() }),
  project: fc.record({ id: fc.string(), name: fc.string(), type: fc.string() }),
});

// Independent oracle: the FIRST key whose integrationId === integrationId OR
// diagram.id === diagramId; its apiKey/sync/noContent, else null.
function oracle(
  keys: readonly ExecutionKey[],
  integrationId: string,
  diagramId: string,
): SelectedKey | null {
  const match = keys.find(
    (key) => key.integrationId === integrationId || key.diagram.id === diagramId,
  );
  if (match === undefined) {
    return null;
  }
  return { apiKey: match.apiKey, sync: match.sync, noContent: match.noContent };
}

describe("Feature: ipaas-helper-extension, Property 13: Execution-key selection", () => {
  it("selects the first key matching integrationId or diagramId, else null", () => {
    fc.assert(
      fc.property(
        fc.array(executionKey, { maxLength: 8 }),
        id,
        id,
        (keys, integrationId, diagramId) => {
          const result = selectExecutionKey(keys, integrationId, diagramId);
          const expected = oracle(keys, integrationId, diagramId);

          if (expected === null) {
            // No key matches -> none (Req 9.3).
            expect(result).toBeNull();
          } else {
            // A matching key exposes its apiKey/sync/noContent (Req 9.2).
            expect(result).not.toBeNull();
            expect(result).toEqual(expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
