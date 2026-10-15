// CanvasHighlighter: best-effort node targeting and status highlighting on the
// builder canvas (Requirement 15).
//
// Isolated and failure-tolerant: it must never break textual tracking. When a
// node cannot be located, highlight() returns false so the tracking UI
// (Requirements 12-14) proceeds unchanged (Req 15.3). The canvas is identified
// by the single element bearing `svg.svg-connections`; nodes are matched with
// `div[id^="${componentId}"]`. Because the builder canvas renders nodes
// asynchronously after page load, a MutationObserver re-applies pending
// highlights as matching nodes appear.

import type { StepStatus } from "../models";
import { isTerminal } from "../models";

export interface CanvasHighlighter {
  // Returns true if the node was found and highlighted; false if not locatable (Req 15.3)
  highlight(componentId: string, status: StepStatus): boolean;
  clearAll(): void;
}

// Class applied to highlighted nodes so clearAll() can find them all.
const HIGHLIGHT_CLASS = "ipaas-helper-node-highlight";
// Per-status modifier class carrying the status color (Req 15.1, 15.2).
const STATUS_CLASS_PREFIX = "ipaas-helper-status-";
const STYLE_ELEMENT_ID = "ipaas-helper-highlight-styles";

// Status -> color. Terminal states (DONE/ERROR) and in-flight states each get a
// distinct, recognizable color (Req 15.1, 15.2).
const STATUS_COLORS: Record<StepStatus, string> = {
  PROCESSING: "#FFCC5C", // yellow — in flight
  DONE: "#1AB83F", // green — terminal success
  ERROR: "#c62828", // red — terminal failure
  REPROCESSED: "#f9a825", // amber — reprocessed
};

function statusClass(status: StepStatus): string {
  return `${STATUS_CLASS_PREFIX}${status}`;
}

export class DomCanvasHighlighter implements CanvasHighlighter {
  private readonly doc: Document;
  // componentId -> last requested status, so the observer can (re)apply the
  // correct highlight once a node renders asynchronously.
  private readonly pending = new Map<string, StepStatus>();
  // componentId -> status currently applied to the DOM node, so we only play
  // the light-up animation when a node first lights up or changes status
  // (never on every poll, which caused a repeated "blink").
  private readonly applied = new Map<string, StepStatus>();
  private observer: MutationObserver | null = null;
  private styleInjected = false;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  highlight(componentId: string, status: StepStatus): boolean {
    // Best-effort: any unexpected DOM failure must not break textual tracking.
    try {
      if (!componentId) {
        return false;
      }

      // Record the latest desired status so the observer can apply it when a
      // not-yet-rendered node appears, and so a terminal status overrides an
      // earlier in-flight one (Req 15.2).
      this.pending.set(componentId, status);
      this.ensureStyles();
      this.ensureObserver();

      const node = this.findNode(componentId);
      if (!node) {
        // Node not locatable: textual tracking proceeds unchanged (Req 15.3).
        return false;
      }

      this.applyStatus(node, status);
      // Once a terminal status has been applied, no further updates are needed.
      if (isTerminal(status)) {
        this.pending.delete(componentId);
      }
      return true;
    } catch {
      return false;
    }
  }

  clearAll(): void {
    try {
      this.pending.clear();
      this.applied.clear();
      const highlighted = this.doc.querySelectorAll<HTMLElement>(
        `.${HIGHLIGHT_CLASS}`,
      );
      highlighted.forEach((el) => this.clearNode(el));
    } catch {
      // Best-effort cleanup — ignore DOM failures.
    } finally {
      this.disconnectObserver();
    }
  }

  // Locate the node for a resolved DOM node id within the single
  // svg.svg-connections canvas. The caller passes the EXACT canvas node id
  // (the flow activity key, e.g. "id3" or "id-generator1"), so this is an exact
  // id match — a prefix match would wrongly also hit "id30", "id31", etc.
  // Returns null when the node is not present.
  //
  // The search is document-wide. The nodes do NOT live inside the connections
  // svg's parent (`dropzone-connections`); they render in a sibling container
  // (`#dropzone`). An earlier parent-scoped search found nothing even though the
  // nodes exist (verified: exactInDoc=true but exactInRoot=false). The activity
  // key is specific enough that an exact `#id` lookup is safe document-wide.
  private findNode(nodeId: string): HTMLElement | null {
    // getElementById already returns the single element with that exact id (or
    // null). Return it directly; `classList` is all the caller touches, so a
    // plain Element is sufficient and we avoid an `instanceof HTMLElement`
    // check (HTMLElement is not a global in every runtime).
    return this.doc.getElementById(nodeId) as HTMLElement | null;
  }

  private applyStatus(node: HTMLElement, status: StepStatus): void {
    const key = node.id;
    const prev = this.applied.get(key);
    if (prev === status && node.classList.contains(HIGHLIGHT_CLASS)) {
      // Already lit in this exact status: leave it solid, no re-animation.
      return;
    }
    // Remove any previous status modifier before applying the new one so a
    // node transitions cleanly (e.g. PROCESSING -> DONE) (Req 15.2).
    this.removeStatusClasses(node);
    node.classList.remove(HIGHLIGHT_CLASS);
    // Force a reflow so re-adding the class (re)starts the CSS animation for
    // this first-light / status-change only.
    void (node as unknown as { offsetWidth: number }).offsetWidth;
    node.classList.add(HIGHLIGHT_CLASS, statusClass(status));
    this.applied.set(key, status);
  }

  private clearNode(node: HTMLElement): void {
    node.classList.remove(HIGHLIGHT_CLASS);
    this.removeStatusClasses(node);
  }

  private removeStatusClasses(node: HTMLElement): void {
    (Object.keys(STATUS_COLORS) as StepStatus[]).forEach((s) =>
      node.classList.remove(statusClass(s)),
    );
  }

  // Inject the status-colored stylesheet once.
  private ensureStyles(): void {
    if (this.styleInjected || this.doc.getElementById(STYLE_ELEMENT_ID)) {
      this.styleInjected = true;
      return;
    }
    const head = this.doc.head ?? this.doc.documentElement;
    if (!head) {
      return;
    }
    const style = this.doc.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    // Each component "lights up" once (on first light or status change) with a
    // calm glow fade-in: the ring and a soft halo ease in from transparent to
    // the solid status color, then the halo gently relaxes. No harsh spike, so
    // it reads as a smooth light-up rather than a blink. `outline` renders the
    // crisp ring; the animatable `box-shadow` carries the glow (outline-color
    // is not reliably animatable across engines).
    const pulse = (color: string): string =>
      `from{box-shadow:0 0 0 0 ${color}00;outline-color:${color}00;}` +
      `60%{box-shadow:0 0 14px 4px ${color}80;outline-color:${color};}` +
      `to{box-shadow:0 0 6px 1px ${color}40;outline-color:${color};}`;
    const base =
      `.${HIGHLIGHT_CLASS}{outline-offset:2px;}` +
      `@keyframes ipaas-helper-node-fade-PROCESSING{${pulse(STATUS_COLORS.PROCESSING)}}` +
      `@keyframes ipaas-helper-node-fade-DONE{${pulse(STATUS_COLORS.DONE)}}` +
      `@keyframes ipaas-helper-node-fade-ERROR{${pulse(STATUS_COLORS.ERROR)}}` +
      `@keyframes ipaas-helper-node-fade-REPROCESSED{${pulse(STATUS_COLORS.REPROCESSED)}}`;
    const perStatus = (Object.entries(STATUS_COLORS) as [
      StepStatus,
      string,
    ][])
      .map(
        ([status, color]) =>
          `.${HIGHLIGHT_CLASS}.${statusClass(status)}{` +
          `outline:3px solid ${color};outline-offset:2px;` +
          `box-shadow:0 0 6px 1px ${color}40;` +
          `animation:ipaas-helper-node-fade-${status} 700ms ease-out both;}`,
      )
      .join("");
    style.textContent = base + perStatus;
    head.appendChild(style);
    this.styleInjected = true;
  }

  // Observe the canvas for async-rendered nodes and apply any pending
  // highlights as matching nodes appear.
  private ensureObserver(): void {
    if (this.observer) {
      return;
    }
    if (typeof MutationObserver === "undefined") {
      return;
    }
    const target = this.doc.body ?? this.doc.documentElement;
    if (!target) {
      return;
    }
    this.observer = new MutationObserver(() => this.flushPending());
    this.observer.observe(target, { childList: true, subtree: true });
  }

  private disconnectObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  // Re-attempt every pending highlight. Called by the MutationObserver when the
  // DOM changes so that nodes rendered after the initial highlight() call still
  // get highlighted.
  private flushPending(): void {
    if (this.pending.size === 0) {
      return;
    }
    for (const [componentId, status] of [...this.pending]) {
      const node = this.findNode(componentId);
      if (node) {
        this.applyStatus(node, status);
        if (isTerminal(status)) {
          this.pending.delete(componentId);
        }
      }
    }
  }
}

