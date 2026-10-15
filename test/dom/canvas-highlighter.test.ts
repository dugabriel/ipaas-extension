// Integration/DOM test for the CanvasHighlighter (Task 14.3).
//
// Exercises DomCanvasHighlighter from src/builder/canvas-highlighter.ts against a
// fixture builder canvas in jsdom:
//  - a located node gets the highlight class plus the per-status class, and the
//    status class updates to the terminal status on a later highlight()
//    (Req 15.1, 15.2);
//  - an absent componentId makes highlight() return false and leaves every node
//    unhighlighted (Req 15.3);
//  - clearAll() removes the highlight + status classes from all nodes.
//
// The highlighter locates the canvas via `svg.svg-connections` and uses the
// svg's parentElement as the search root, matching `div[id^="${componentId}"]`.
//
// Requirements: 15.1, 15.2, 15.3
import { describe, it, expect, beforeEach } from "vitest";
import { DomCanvasHighlighter } from "../../src/builder/canvas-highlighter";

const HIGHLIGHT_CLASS = "ipaas-helper-node-highlight";
const STATUS_CLASS_PREFIX = "ipaas-helper-status-";

function statusClass(status: string): string {
  return `${STATUS_CLASS_PREFIX}${status}`;
}

// Build a fixture canvas: a container holding the single svg.svg-connections and
// sibling node divs whose ids EQUAL the given node ids. The highlighter uses the
// svg's parentElement (the container) as its node search root. The real builder
// renders each component as `<div id="<activityKey>">` (e.g. "id3"), so the
// highlighter matches the resolved node id exactly.
function buildCanvas(componentIds: string[]): void {
  const container = document.createElement("div");
  container.className = "builder-canvas";

  const svg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  svg.setAttribute("class", "svg-connections");
  container.appendChild(svg);

  // Nodes render as siblings of the connections svg inside the container, with
  // the activity key as their exact DOM id.
  for (const id of componentIds) {
    const node = document.createElement("div");
    node.id = id;
    node.className = "canvas-node";
    container.appendChild(node);
  }

  document.body.appendChild(container);
}

function nodeFor(nodeId: string): HTMLElement {
  const el = document.getElementById(nodeId);
  if (!el) {
    throw new Error(`fixture node for ${nodeId} not found`);
  }
  return el;
}

describe("DomCanvasHighlighter against a fixture canvas (DOM)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("highlights a located node and updates it to the terminal status (Req 15.1, 15.2)", () => {
    const componentId = "comp-1";
    buildCanvas([componentId, "comp-2"]);
    const highlighter = new DomCanvasHighlighter(document);

    // In-flight status (Req 15.1).
    expect(highlighter.highlight(componentId, "PROCESSING")).toBe(true);

    const node = nodeFor(componentId);
    expect(node.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(node.classList.contains(statusClass("PROCESSING"))).toBe(true);

    // Terminal status replaces the in-flight status class (Req 15.2).
    expect(highlighter.highlight(componentId, "DONE")).toBe(true);
    expect(node.classList.contains(HIGHLIGHT_CLASS)).toBe(true);
    expect(node.classList.contains(statusClass("DONE"))).toBe(true);
    expect(node.classList.contains(statusClass("PROCESSING"))).toBe(false);

    // The other node is untouched.
    const other = nodeFor("comp-2");
    expect(other.classList.contains(HIGHLIGHT_CLASS)).toBe(false);
  });

  it("returns false and highlights nothing when the node is absent (Req 15.3)", () => {
    buildCanvas(["comp-1"]);
    const highlighter = new DomCanvasHighlighter(document);

    expect(highlighter.highlight("missing-component", "PROCESSING")).toBe(false);

    // No node in the canvas gained the highlight class.
    const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
    expect(highlighted.length).toBe(0);
  });

  it("clearAll removes highlight and status classes from all nodes", () => {
    buildCanvas(["comp-1", "comp-2"]);
    const highlighter = new DomCanvasHighlighter(document);

    highlighter.highlight("comp-1", "DONE");
    highlighter.highlight("comp-2", "ERROR");
    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(2);

    highlighter.clearAll();

    expect(document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).length).toBe(0);
    const node1 = nodeFor("comp-1");
    const node2 = nodeFor("comp-2");
    expect(node1.classList.contains(statusClass("DONE"))).toBe(false);
    expect(node2.classList.contains(statusClass("ERROR"))).toBe(false);
  });
});
