// Unit tests for ExecutionModal rendering and open-on-click (Task 10.3).
//
// Exercises the DOM factory `createExecutionModal` and the `openModalOnExecuteClick`
// wiring from src/builder/execution-modal.ts against jsdom:
//  - the modal exposes both a JSON body input and an HTTP headers input (Req 10.1);
//  - clicking a wired execute button opens the modal, i.e. the overlay becomes
//    visible (style.display !== "none") (Req 8.5);
//  - the confirm button is gated (disabled) until both inputs validate (Req 10.4).
//
// Requirements: 8.5, 10.1
import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecutionModal,
  openModalOnExecuteClick,
} from "../../src/builder/execution-modal";

describe("ExecutionModal rendering and open-on-click (DOM)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders both a JSON body input and an HTTP headers input (Req 10.1)", () => {
    const modal = createExecutionModal(document);

    // Both inputs are present as textareas.
    expect(modal.bodyInput).toBeInstanceOf(HTMLTextAreaElement);
    expect(modal.headersInput).toBeInstanceOf(HTMLTextAreaElement);

    // And both live inside the modal overlay subtree once mounted.
    document.body.appendChild(modal.overlay);
    expect(
      modal.overlay.querySelector("textarea.ipaas-exec-modal-body"),
    ).toBe(modal.bodyInput);
    expect(
      modal.overlay.querySelector("textarea.ipaas-exec-modal-headers"),
    ).toBe(modal.headersInput);
  });

  it("opens the modal when the execute button is clicked (Req 8.5)", () => {
    const modal = createExecutionModal(document);
    document.body.appendChild(modal.overlay);

    const executeButton = document.createElement("button");
    executeButton.type = "button";
    document.body.appendChild(executeButton);

    openModalOnExecuteClick(executeButton, modal);

    // The modal starts hidden.
    expect(modal.overlay.style.display).toBe("none");

    executeButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // After the click the overlay is visible.
    expect(modal.overlay.style.display).not.toBe("none");
  });

  it("removes the click listener when the cleanup function runs", () => {
    const modal = createExecutionModal(document);
    document.body.appendChild(modal.overlay);

    const executeButton = document.createElement("button");
    const cleanup = openModalOnExecuteClick(executeButton, modal);

    cleanup();
    executeButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // With the listener removed, the modal stays hidden on click.
    expect(modal.overlay.style.display).toBe("none");
  });

  it("gates the confirm button until both inputs are valid (Req 10.4)", () => {
    const modal = createExecutionModal(document);
    document.body.appendChild(modal.overlay);

    // The modal pre-fills a valid example body + a valid header, so confirm
    // starts enabled (both validators pass out of the box).
    expect(modal.confirmButton.disabled).toBe(false);

    // Invalid JSON body gates the confirm button.
    modal.bodyInput.value = "{ not json";
    modal.bodyInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(modal.confirmButton.disabled).toBe(true);

    // Back to valid JSON re-enables it.
    modal.bodyInput.value = "{}";
    modal.bodyInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(modal.confirmButton.disabled).toBe(false);

    // An invalid header line re-gates the confirm button.
    modal.headersInput.value = "no-colon-here";
    modal.headersInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(modal.confirmButton.disabled).toBe(true);
  });
});
