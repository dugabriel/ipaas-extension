// Feature: ipaas-helper-extension, Property 19: Canvas-highlighter isolation
//
// Property statement: For any Execution_Step whose canvas node cannot be
// located, highlight returns false and the textual tracking output is identical
// to the output produced with no highlighter active.
//
// Since the textual tracking output is produced elsewhere (Requirements 12-14),
// isolation is asserted structurally: when no element with the step's resolved
// node id exists, highlight(...) returns false and the DOM gains no highlight
// class on any element. A missing-node highlight is therefore a no-op that
// cannot perturb anything the textual tracking display reads.
//
// Node targeting is a document-wide EXACT id lookup (getElementById): the real
// builder renders each component as `<div id="<activityKey>">`, and those nodes
// live in a sibling container of the connections svg (not inside it), so a
// node is locatable iff an element with that exact id exists in the document.
//
// Validates: Requirements 15.3
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import { DomCanvasHighlighter } from "../../src/builder/canvas-highlighter";
import type { StepStatus } from "../../src/models";

// Classes the implementation applies when it successfully highlights a node.
const HIGHLIGHT_CLASS = "ipaas-helper-node-highlight";
const STATUS_CLASS_PREFIX = "ipaas-helper-status-";

const statusArb: fc.Arbitrary<StepStatus> = fc.constantFrom(
  "PROCESSING",
  "DONE",
  "ERROR",
  "REPROCESSED",
);

// Arbitrary node ids, including awkward values (empty, whitespace, quotes,
// backslashes, selector metacharacters) that must still be handled safely.
const nodeIdArb = fc.oneof(
  fc.string(),
  fc.constantFrom("", " ", '"', "\\", "]", "[id", "a b", "node.1", "#x"),
  fc.string({ minLength: 1 }).map((s) => `component-${s}`),
);

// Build a DOM in which NO element has the exact id `nodeId`, exercising the
// shapes the implementation must treat as "node cannot be located":
//  - empty: nothing in the document;
//  - unrelated-nodes: elements exist but none with the exact id;
//  - canvas-only: the connections svg exists but no matching node.
type DomShape = "empty" | "unrelated-nodes" | "canvas-only";

function buildDom(shape: DomShape, nodeId: string): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";

  switch (shape) {
    case "empty":
      break;
    case "unrelated-nodes": {
      // Elements exist, but their ids are guaranteed distinct from nodeId.
      const container = document.createElement("div");
      const other = document.createElement("div");
      other.id = `zzz-unrelated-${nodeId}-tail`;
      // Only add it when its id is genuinely different from nodeId.
      if (other.id !== nodeId) {
        container.appendChild(other);
      }
      document.body.appendChild(container);
      break;
    }
    case "canvas-only": {
      // The connections svg exists but there is no element with the exact id.
      const container = document.createElement("div");
      container.innerHTML = `<svg class="svg-connections"></svg>`;
      document.body.appendChild(container);
      break;
    }
  }
}

const shapeArb = fc.constantFrom<DomShape>(
  "empty",
  "unrelated-nodes",
  "canvas-only",
);

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("Feature: ipaas-helper-extension, Property 19: Canvas-highlighter isolation", () => {
  it("returns false and applies no highlight class when the node cannot be located", () => {
    fc.assert(
      fc.property(
        shapeArb,
        nodeIdArb,
        statusArb,
        (shape, nodeId, status) => {
          buildDom(shape, nodeId);
          // Guard: only assert isolation for ids that are truly absent.
          fc.pre(nodeId === "" || document.getElementById(nodeId) === null);

          const highlighter = new DomCanvasHighlighter(document);
          const result = highlighter.highlight(nodeId, status);

          // A node that cannot be located yields false (Req 15.3).
          expect(result).toBe(false);

          // Textual tracking is unaffected: no element anywhere gained the
          // highlight marker or a status modifier class.
          expect(document.querySelector(`.${HIGHLIGHT_CLASS}`)).toBeNull();
          expect(
            document.querySelector(`[class*="${STATUS_CLASS_PREFIX}"]`),
          ).toBeNull();

          highlighter.clearAll();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is a no-op across repeated missing-node highlight calls", () => {
    fc.assert(
      fc.property(
        shapeArb,
        fc.array(fc.tuple(nodeIdArb, statusArb), {
          minLength: 1,
          maxLength: 6,
        }),
        (shape, calls) => {
          buildDom(shape, calls[0][0]);

          const highlighter = new DomCanvasHighlighter(document);
          for (const [nodeId, status] of calls) {
            // Only assert isolation for ids genuinely absent from the document.
            const locatable =
              nodeId !== "" && document.getElementById(nodeId) !== null;
            fc.pre(!locatable);
            expect(highlighter.highlight(nodeId, status)).toBe(false);
          }

          expect(document.querySelector(`.${HIGHLIGHT_CLASS}`)).toBeNull();
          highlighter.clearAll();
        },
      ),
      { numRuns: 100 },
    );
  });
});
