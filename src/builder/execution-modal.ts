// ExecutionModal: JSON body and HTTP header inputs, validators, and submit
// gating (Req 8.5, 10.1-10.4).
//
// The validators (validateBody, validateHeaders, canSubmit) are PURE and
// exported so they can be property-tested (Property 14). DOM rendering and the
// open-on-click wiring are kept separate from the validation logic.

// --- Validation result types ------------------------------------------------

export type BodyValidation =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

export type HeadersValidation =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string };

// --- Pure validators ---------------------------------------------------------

/**
 * Validate the request body (Req 10.2).
 *
 * The body must parse as valid JSON. On success the parsed value is returned;
 * on failure a human-readable message identifying the body as invalid is
 * returned.
 */
export function validateBody(raw: string): BodyValidation {
  try {
    const value = JSON.parse(raw) as unknown;
    return { ok: true, value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Request body is not valid JSON: ${detail}` };
  }
}

// RFC 7230 field-name is a `token`, composed of `tchar`:
//   tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
//           "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
const FIELD_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// A field-value must be free of control characters (C0 controls and DEL).
// We allow printable characters (including surrounding/internal spaces, which
// are trimmed off the edges before this check).
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate the HTTP headers (Req 10.3).
 *
 * Each NON-BLANK line must be a single `name: value` pair where:
 *  - `name` contains only RFC 7230 field-name (token) characters, and
 *  - `value` is free of control characters.
 *
 * Blank (whitespace-only) lines are ignored. On success a map of header name
 * to value is returned; on failure a message identifying the offending line is
 * returned.
 */
export function validateHeaders(raw: string): HeadersValidation {
  const value: Record<string, string> = {};
  const lines = raw.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      continue; // ignore blank lines
    }

    const lineNo = i + 1;
    const colon = line.indexOf(":");
    if (colon === -1) {
      return {
        ok: false,
        message: `Header line ${lineNo} is not a "name: value" pair`,
      };
    }

    const name = line.slice(0, colon).trim();
    const headerValue = line.slice(colon + 1).trim();

    if (name === "" || !FIELD_NAME_RE.test(name)) {
      return {
        ok: false,
        message: `Header line ${lineNo} has an invalid header name`,
      };
    }

    if (CONTROL_CHAR_RE.test(headerValue)) {
      return {
        ok: false,
        message: `Header line ${lineNo} has an invalid header value`,
      };
    }

    value[name] = headerValue;
  }

  return { ok: true, value };
}

/**
 * Whether the current body and headers inputs can be submitted (Req 10.4).
 * True iff both the body and the headers validate.
 */
export function canSubmit(bodyRaw: string, headersRaw: string): boolean {
  return validateBody(bodyRaw).ok && validateHeaders(headersRaw).ok;
}

// --- DOM rendering (kept separate from the pure validators) ------------------

export interface ExecutionModalElements {
  overlay: HTMLDivElement;
  bodyInput: HTMLTextAreaElement;
  headersInput: HTMLTextAreaElement;
  bodyError: HTMLDivElement;
  headersError: HTMLDivElement;
  confirmButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

export interface ExecutionModalHandle extends ExecutionModalElements {
  /** Make the modal visible. */
  open(): void;
  /** Hide the modal. */
  close(): void;
  /** Re-run validation and update messages + confirm-button gating. */
  refresh(): void;
}

export interface ExecutionModalOptions {
  /** Invoked with the parsed body and headers when the user confirms. */
  onConfirm?(payload: { body: unknown; headers: Record<string, string> }): void;
  /** Invoked when the user cancels/closes the modal. */
  onCancel?(): void;
  /** Pre-filled example body (JSON text) derived from the flow. */
  initialBody?: string;
  /** Pre-filled example headers ("Name: value" lines) derived from the flow. */
  initialHeaders?: string;
}

/**
 * Build the ExecutionModal DOM: a JSON body input and an HTTP headers input
 * (Req 10.1), with inline validation messages and a confirm button that is
 * gated on canSubmit (Req 10.2-10.4). The modal starts hidden; call open() to
 * show it.
 */
export function createExecutionModal(
  doc: Document,
  options: ExecutionModalOptions = {},
): ExecutionModalHandle {
  const overlay = doc.createElement("div");
  overlay.className = "ipaas-exec-modal-overlay";
  overlay.style.display = "none";

  const dialog = doc.createElement("div");
  dialog.className = "ipaas-exec-modal";
  overlay.appendChild(dialog);

  // Body input.
  const bodyLabel = doc.createElement("label");
  bodyLabel.textContent = "Corpo da requisição (JSON)";
  const bodyInput = doc.createElement("textarea");
  bodyInput.className = "ipaas-exec-modal-body";
  // Pre-filled example so the user can run immediately and sees the expected
  // shape. Defaults to a generic example when the caller provides none.
  bodyInput.value = options.initialBody ?? '{\n  "teste": 1\n}';
  const bodyError = doc.createElement("div");
  bodyError.className = "ipaas-exec-modal-error";

  // Headers input.
  const headersLabel = doc.createElement("label");
  headersLabel.textContent = "Cabeçalhos HTTP (um por linha, nome: valor)";
  const headersInput = doc.createElement("textarea");
  headersInput.className = "ipaas-exec-modal-headers";
  headersInput.value = options.initialHeaders ?? "Content-Type: application/json";
  const headersError = doc.createElement("div");
  headersError.className = "ipaas-exec-modal-error";

  // Actions.
  const confirmButton = doc.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "ipaas-exec-modal-confirm";
  confirmButton.textContent = "Executar";

  const cancelButton = doc.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "ipaas-exec-modal-cancel";
  cancelButton.textContent = "Cancelar";

  dialog.append(
    bodyLabel,
    bodyInput,
    bodyError,
    headersLabel,
    headersInput,
    headersError,
    confirmButton,
    cancelButton,
  );

  const handle: ExecutionModalHandle = {
    overlay,
    bodyInput,
    headersInput,
    bodyError,
    headersError,
    confirmButton,
    cancelButton,
    open() {
      overlay.style.display = "";
      handle.refresh();
    },
    close() {
      overlay.style.display = "none";
    },
    refresh() {
      const body = validateBody(bodyInput.value);
      const headers = validateHeaders(headersInput.value);

      bodyError.textContent = body.ok ? "" : body.message;
      headersError.textContent = headers.ok ? "" : headers.message;

      confirmButton.disabled = !(body.ok && headers.ok);
    },
  };

  bodyInput.addEventListener("input", handle.refresh);
  headersInput.addEventListener("input", handle.refresh);

  confirmButton.addEventListener("click", () => {
    const body = validateBody(bodyInput.value);
    const headers = validateHeaders(headersInput.value);
    if (!body.ok || !headers.ok) {
      handle.refresh();
      return;
    }
    options.onConfirm?.({ body: body.value, headers: headers.value });
  });

  cancelButton.addEventListener("click", () => {
    handle.close();
    options.onCancel?.();
  });

  // Initialize gating/messages for the starting (empty) inputs.
  handle.refresh();

  return handle;
}

/**
 * Open the modal when the execute button is clicked (Req 8.5). Returns a
 * cleanup function that removes the listener.
 */
export function openModalOnExecuteClick(
  executeButton: HTMLElement,
  modal: ExecutionModalHandle,
): () => void {
  const listener = () => modal.open();
  executeButton.addEventListener("click", listener);
  return () => executeButton.removeEventListener("click", listener);
}
