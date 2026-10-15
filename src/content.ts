// Builder content-script entry point (matches https://ipaas.totvs.app/builder/*).
// Hosts BuilderHelpers, ExecutionModal, tracking UI, and CanvasHighlighter.
//
// Task 7.1 implemented the activation guard and flow loading:
//  - activate only on `/builder/{diagramId}` with a single non-empty segment (Req 1.3);
//  - read the Diagram_Id from the path (Req 5.1);
//  - request the Integration via the worker (GET_FLOW -> first item) (Req 5.2);
//  - expose id/name/active/status/flow to the helpers on success (Req 5.3);
//  - render flow-unavailable / 401 re-auth / could-not-load messages and keep the
//    helpers inactive on those branches (Req 5.4, 5.5, 5.6).
//
// Task 15.2 wires the active surface end-to-end:
//  - render the BuilderHelpers output (function origins + condition summaries)
//    once the flow loads (Req 1.2, 5.3, 6, 7);
//  - render the execute button on the start node when the precondition holds and
//    open the ExecutionModal on click (Req 8.5);
//  - on modal confirm run the confirm->execute flow and, on a tracking outcome,
//    open the tracking Port, send TRACK_START, and drive the textual tracking UI
//    plus the best-effort CanvasHighlighter from the streamed step state
//    (Req 11.2, 12.2, 15.1).
import {
  isBuilderPath,
  extractDiagramId,
  resolveActivation,
  type ActiveBuilderContext,
  type ActivationOutcome,
} from "./builder/activation";
import {
  resolveFunctionOrigins,
  summarizeConditions,
  shouldShowExecuteButton,
  renderFunctionOrigins,
  renderConditionSummaries,
  buildStepNodeIndex,
  resolveStepNodeId,
} from "./builder/builder-helpers";
import {
  createExecutionModal,
  openModalOnExecuteClick,
  type ExecutionModalHandle,
} from "./builder/execution-modal";
import {
  DomCanvasHighlighter,
  type CanvasHighlighter,
} from "./builder/canvas-highlighter";
import {
  resolveKeySelection,
  type KeySelectionOutcome,
} from "./builder/key-selection";
import {
  buildExecuteRequest,
  resolveExecutionOutcome,
  type ExecutionOutcome,
} from "./builder/execution-flow";
import {
  TRACK_PORT_NAME,
  type GetFlowRequest,
  type GetKeysRequest,
  type ApiResult,
  type TrackStartMessage,
  type PortResponse,
  type CaptureTokenResponse,
} from "./messaging/protocol";
import type {
  Integration,
  ExecutionKey,
  ExecutionResponse,
  ExecutionStep,
  Message,
} from "./models";
import { addHistoryEntry } from "./history";
import { buildExamplePayload } from "./builder/example-payload";

const CONTAINER_ID = "ipaas-helper-root";

const COOKIE_NAME = "jwt.token";

/** True when an element exists and is actually rendered (has layout). */
function isVisible(el: HTMLElement | null): boolean {
  return !!el && !!el.offsetParent && el.getClientRects().length > 0;
}

/** True when a container matching `selector` has at least one visible child. */
function hasVisibleChild(selector: string): boolean {
  const container = document.querySelector<HTMLElement>(selector);
  if (!container) return false;
  return Array.from(container.children).some((c) =>
    isVisible(c as HTMLElement),
  );
}

const NODE_HILITE_CLASS = "ipaas-helper-node-hover";

/**
 * Highlights the canvas node whose DOM id EXACTLY equals `nodeId` (the builder
 * renders each component as `<div id="<activityKey>">`, e.g. "id16"). Pass null
 * to clear any current highlight. Best-effort: a missing node is a no-op so it
 * never breaks the panel.
 */
function highlightNodeById(nodeId: string | null): void {
  // Clear previous.
  document
    .querySelectorAll<HTMLElement>(`.${NODE_HILITE_CLASS}`)
    .forEach((el) => el.classList.remove(NODE_HILITE_CLASS));
  if (!nodeId) return;
  // There can be a sibling `.component-anchor-dot` with the same id; mark all.
  const nodes = document.querySelectorAll<HTMLElement>(
    `[id="${(window.CSS && CSS.escape ? CSS.escape(nodeId) : nodeId)}"]`,
  );
  let first: HTMLElement | null = null;
  nodes.forEach((n) => {
    n.classList.add(NODE_HILITE_CLASS);
    if (!first) first = n;
  });
  // Bring it into view if off-screen (best-effort).
  if (first) {
    try {
      (first as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    } catch {
      // ignore
    }
  }
}

/**
 * Reads the `jwt.token` value from this tab's `document.cookie` (Req 2.1, 2.3).
 * This is the authoritative session source: it is the exact token for the tab's
 * company and browser profile (normal or Incognito). Returns null when absent
 * or empty.
 */
export function readJwtFromDocumentCookie(): string | null {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) {
    return null;
  }
  const value = match.slice(COOKIE_NAME.length + 1);
  return value !== "" ? decodeURIComponent(value) : null;
}

/**
 * Captures the token from `document.cookie` and asks the worker to persist it in
 * the Session_Store (Req 2.3, 2.4). Returns the captured value (or null).
 */
async function captureAndStoreToken(): Promise<string | null> {
  const token = readJwtFromDocumentCookie();
  await chrome.runtime.sendMessage({ type: "STORE_TOKEN", token });
  return token;
}

/**
 * Content-script bootstrap. Runs the path guard, loads the flow via the worker,
 * and renders either the active helper surface or the appropriate inactive
 * branch message.
 */
export async function activate(): Promise<void> {
  // Req 1.3: keep the helpers inactive on any non-builder path.
  if (!isBuilderPath(location.pathname)) {
    return;
  }

  const diagramId = extractDiagramId(location.pathname);
  if (diagramId === null) {
    return;
  }

  // Req 2.3: the builder captures its own token from document.cookie before any
  // authenticated call, so the worker always uses this tab's current session.
  await captureAndStoreToken();

  const result = await requestFlow(diagramId);
  const outcome = resolveActivation(diagramId, result);
  render(outcome);
  startPanelVisibilityWatcher();
}

/**
 * Hides the floating helper panel whenever a builder configuration overlay /
 * dialog is open, so our panel never covers the product's own UI. Mirrors the
 * trigger-button guard.
 */
function startPanelVisibilityWatcher(): void {
  const sync = (): void => {
    const panel = document.getElementById(CONTAINER_ID);
    if (!panel) return;
    const overlayOpen =
      isVisible(document.querySelector<HTMLElement>("side-overlay-component .dialog")) ||
      isVisible(document.querySelector<HTMLElement>(".configurations")) ||
      hasVisibleChild(".cdk-overlay-container");
    panel.style.visibility = overlayOpen ? "hidden" : "";
  };
  sync();
  const observer = new MutationObserver(() => sync());
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}

/** Sends the GET_FLOW request to the service worker (Req 5.2). */
function requestFlow(
  diagramId: string,
): Promise<ApiResult<Integration | null>> {
  const message: GetFlowRequest = { type: "GET_FLOW", diagramId };
  return chrome.runtime.sendMessage(message) as Promise<
    ApiResult<Integration | null>
  >;
}

/**
 * Renders the activation outcome. On success it exposes the Integration context
 * to the helpers (Req 5.3); on every inactive branch it shows the branch message
 * and leaves the helpers inactive (Req 5.4, 5.5, 5.6).
 */
function render(outcome: ActivationOutcome): void {
  const container = ensureContainer();

  if (!outcome.active) {
    container.dataset.active = "false";
    container.dataset.reason = outcome.reason;
    container.textContent = outcome.message;
    return;
  }

  container.dataset.active = "true";
  delete container.dataset.reason;
  activateHelpers(container, outcome.context);
}

/**
 * Mounts the builder helpers for the resolved Integration (Req 1.2, 5.3). It
 * renders the function origins and condition summaries (Req 6, 7) and, when the
 * execute precondition holds (Req 8), the execute button + ExecutionModal whose
 * confirm drives the execute->tracking flow (task 15.2).
 *
 * The context and confirm flow are also exposed on the container so the
 * integration tests (task 15.3) can observe the wiring.
 */
function activateHelpers(
  container: HTMLElement,
  context: ActiveBuilderContext,
): void {
  container.textContent = "";

  // Header with the integration name so the panel reads as part of the product.
  // Clicking the header collapses/expands the panel body.
  const header = document.createElement("div");
  header.className = "ipaas-helper-header";
  const titleWrap = document.createElement("span");
  titleWrap.className = "ipaas-helper-header-title";
  const caret = document.createElement("span");
  caret.className = "ipaas-helper-header-caret";
  caret.textContent = "▾";
  const title = document.createElement("span");
  title.textContent = "iPaaS Helper";
  titleWrap.append(caret, title);
  const name = document.createElement("span");
  name.className = "ipaas-helper-integration-name";
  name.textContent = context.name ?? "";
  name.style.fontWeight = "400";
  name.style.color = "rgba(255,255,255,0.85)";
  name.style.fontSize = "11px";
  header.append(titleWrap, name);
  header.title = "Clique para recolher/expandir";
  container.appendChild(header);

  const body = document.createElement("div");
  body.className = "ipaas-helper-body";
  container.appendChild(body);

  // Collapse/expand on header click. Persist the choice for the session so it
  // stays collapsed across re-renders/navigation within the same tab.
  const COLLAPSE_KEY = "ipaasHelperCollapsed";
  const applyCollapsed = (collapsed: boolean): void => {
    body.style.display = collapsed ? "none" : "";
    caret.textContent = collapsed ? "▸" : "▾";
    container.classList.toggle("ipaas-helper-collapsed", collapsed);
  };
  // Start collapsed by default; respect a stored preference once the user toggles.
  const stored = sessionStorage.getItem(COLLAPSE_KEY);
  let collapsed = stored === null ? true : stored === "1";
  applyCollapsed(collapsed);
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    sessionStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    applyCollapsed(collapsed);
  });

  // Req 6, 7 — render the BuilderHelpers output from the loaded flow.
  renderBuilderHelpers(body, context);

  // Req 8.5 — show the execute button on the start node and open the modal.
  mountExecuteFlow(body, context);

  (container as unknown as { __context?: ActiveBuilderContext }).__context =
    context;
  (
    container as unknown as {
      __confirmExecution?: (payload: {
        body: unknown;
        headers: Record<string, string>;
      }) => Promise<ExecutionOutcome | KeySelectionOutcome>;
    }
  ).__confirmExecution = (payload) => confirmExecution(context, payload);
}

/**
 * Renders the function origins and condition summaries resolved from the loaded
 * flow (Req 6.2, 6.4, 7.1-7.4). Pure resolvers from builder-helpers.ts produce
 * the data; the render helpers produce the DOM.
 */
function renderBuilderHelpers(
  container: HTMLElement,
  context: ActiveBuilderContext,
): void {
  const flow = context.flow;

  const section = document.createElement("div");
  section.className = "ipaas-helper-builder";

  // Function origins (Req 6) — titled, with an empty-state when none.
  const originsTitle = document.createElement("div");
  originsTitle.className = "ipaas-helper-section-title";
  originsTitle.textContent = "Origem das funções";
  section.appendChild(originsTitle);
  const origins = resolveFunctionOrigins(flow);
  if (origins.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ipaas-helper-empty";
    empty.textContent = "Nenhuma função neste fluxo.";
    section.appendChild(empty);
  } else {
    // Hover over a function highlights the consuming node on the canvas and
    // clears it on leave (best-effort; a missing node is a no-op, Req 15.3).
    section.appendChild(
      renderFunctionOrigins(origins, (activityId) =>
        highlightNodeById(activityId),
      ),
    );
  }

  // Condition summaries (Req 7) — titled, with an empty-state when none.
  const condTitle = document.createElement("div");
  condTitle.className = "ipaas-helper-section-title";
  condTitle.textContent = "Condições";
  section.appendChild(condTitle);
  const summaries = summarizeConditions(flow);
  if (summaries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ipaas-helper-empty";
    empty.textContent = "Nenhuma condição neste fluxo.";
    section.appendChild(empty);
  } else {
    section.appendChild(
      renderConditionSummaries(summaries, (activityId) =>
        highlightNodeById(activityId),
      ),
    );
  }

  container.appendChild(section);
}

/**
 * Renders the execute button on the start node when the precondition holds
 * (Req 8.1-8.5) and wires it to the ExecutionModal. On modal confirm the
 * confirm->execute flow runs; a tracking outcome starts the tracking UI
 * (Req 11.2, 12.2, 15.1). Non-tracking outcomes surface their message.
 */
function mountExecuteFlow(
  _container: HTMLElement,
  context: ActiveBuilderContext,
): void {
  // Req 8.1-8.4 — only when the start node is a WEBHOOK and the integration is
  // active + PUBLISHED.
  if (!shouldShowExecuteButton(contextIntegration(context))) {
    return;
  }

  // Req 8.1 / Trigger_Overlay — overlay an execute button on the start node.
  // The start node's DOM id equals flow.start (builder renders each component as
  // an element whose id is the component id). We float the button over that
  // element's on-screen rect and keep it aligned as the canvas pans/zooms.
  const startId = context.flow.start;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ipaas-helper-trigger-overlay";
  button.textContent = "▶ Executar";
  button.title = "Executar esta integração";
  document.body.appendChild(button);

  // Build an example body/headers from the flow's trigger tag references so the
  // user starts with a payload tailored to this integration (generic fallback
  // when the flow references no fields).
  const example = buildExamplePayload(context.flow);
  const modal = createExecutionModal(document, {
    initialBody: example.body,
    initialHeaders: example.headers,
    onConfirm: (payload) => {
      modal.close();
      // Pass a reopen callback so the tracking modal can offer "Executar
      // novamente", which returns the user to this pre-execution dialog.
      void runExecution(context, payload, () => modal.open());
    },
  });
  document.body.appendChild(modal.overlay);

  button.addEventListener("click", () => modal.open());

  // Keep the overlay aligned with the start node. The node may not be rendered
  // yet (async canvas), so we poll position on a RAF loop and also observe DOM
  // mutations; the button hides when the node is absent (Req 15.3 isolation).
  const reposition = (): void => {
    // Hide while any helper modal (execution or tracking) is open so the button
    // never overlaps a dialog.
    const helperModalOpen =
      document.querySelector(".ipaas-helper-modal-overlay") !== null ||
      !!document.querySelector<HTMLElement>(".ipaas-exec-modal-overlay")
        ?.offsetParent;
    // Builder's own configuration panels / popovers (side-overlay dialog, CDK
    // overlays, the settings panel). Hide the button whenever any of these is
    // on screen so it never floats over the product's own UI.
    const builderOverlayOpen =
      isVisible(document.querySelector<HTMLElement>("side-overlay-component .dialog")) ||
      isVisible(document.querySelector<HTMLElement>(".configurations")) ||
      hasVisibleChild(".cdk-overlay-container");
    // Inside a splitter sub-flow (or the global-error sub-flow) the builder
    // keeps the main canvas — and the webhook start node — in the DOM, so the
    // start node alone cannot tell us we left the main flow. The product's
    // dropzone template renders a `.splitter-header-wrapper` (splitter sub-flow)
    // / `.global-error-header-wrapper` and a `subflow-footer-component` only
    // while a sub-flow is open; hide the execute button then, since there is no
    // trigger to run from a sub-flow.
    const inSubflow =
      isVisible(document.querySelector<HTMLElement>(".splitter-header-wrapper")) ||
      isVisible(document.querySelector<HTMLElement>(".global-error-header-wrapper")) ||
      isVisible(document.querySelector<HTMLElement>("subflow-footer-component"));
    const node = document.getElementById(startId);
    if (helperModalOpen || builderOverlayOpen || inSubflow || !node) {
      button.style.display = "none";
      return;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      button.style.display = "none";
      return;
    }
    button.style.display = "inline-flex";
    // Place the button to the LEFT of the node, vertically centered, so it does
    // not overlap the node's own configuration overlay (which opens around the
    // node). An 8px gap sits it just outside the node's left edge.
    const gap = 8;
    const top = rect.top + rect.height / 2 - button.offsetHeight / 2;
    let left = rect.left - button.offsetWidth - gap;
    // If there is no room on the left (node near the viewport edge), fall back
    // to above the node.
    if (left < 4) {
      left = rect.left;
      button.style.top = `${Math.max(4, rect.top - button.offsetHeight - gap)}px`;
    } else {
      button.style.top = `${Math.max(4, top)}px`;
    }
    button.style.left = `${left}px`;
  };

  let rafScheduled = false;
  const scheduleReposition = (): void => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      reposition();
    });
  };

  // Initial placement + continuous alignment.
  reposition();
  const observer = new MutationObserver(scheduleReposition);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);
  // A light interval catches canvas transforms that don't trigger mutations.
  const interval = window.setInterval(reposition, 500);

  // Expose handles for tests / cleanup.
  (document.body as unknown as { __ipaasTrigger?: unknown }).__ipaasTrigger = {
    button,
    modal,
    stop: () => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleReposition, true);
      window.removeEventListener("resize", scheduleReposition);
      window.clearInterval(interval);
    },
  };
}

/**
 * Reconstructs the Integration shape `shouldShowExecuteButton` expects from the
 * exposed context. The context already carries id/name/active/status/flow.
 */
function contextIntegration(context: ActiveBuilderContext): Integration {
  return {
    id: context.id,
    name: context.name,
    active: context.active,
    status: context.status,
    flow: context.flow,
  };
}

/**
 * Runs the confirm->execute flow and renders its outcome (Req 11.2-11.5,
 * 9.3-9.5). On a tracking outcome it starts the tracking UI (Req 12.2, 15.1);
 * every other outcome shows its branch message.
 */
async function runExecution(
  context: ActiveBuilderContext,
  payload: { body: unknown; headers: Record<string, string> },
  onRerun?: () => void,
): Promise<void> {
  // Open the Tracking_Modal immediately in a loading state (Req 12.7, 12.8).
  const modal = openTrackingModal(onRerun);
  modal.setSummary("Disparando execução...", true);

  const outcome = await confirmExecution(context, payload);

  // Key-selection failures surface their message (Req 9.3-9.5).
  if ("ok" in outcome) {
    if (!outcome.ok) {
      modal.setSummary(outcome.message, false);
    }
    return;
  }

  switch (outcome.kind) {
    case "tracking":
      // Req 11.2 — show the captured Message_Id (as a link) and begin streaming.
      modal.setSummary(`Execução disparada — ${outcome.status}`, true);
      modal.setMessageId(outcome.messageId);
      // Req 19.1 — record this execution in the capped history.
      void addHistoryEntry({
        messageId: outcome.messageId,
        status: outcome.status,
        timestamp: new Date().toISOString(),
        integrationName: context.name ?? "",
        diagramId: context.diagramId,
      });
      startTracking(context, outcome.messageId, modal);
      break;
    case "no_tracking_id":
    case "unauthorized":
    case "trigger_failed":
      modal.setSummary(outcome.message, false);
      break;
  }
}

/** Sends the GET_KEYS request to the service worker (Req 9.1). */
function requestKeys(): Promise<ApiResult<ExecutionKey[]>> {
  const message: GetKeysRequest = { type: "GET_KEYS" };
  return chrome.runtime.sendMessage(message) as Promise<
    ApiResult<ExecutionKey[]>
  >;
}

/** Sends the EXECUTE request to the service worker (Req 11.1). */
function requestExecute(
  request: ReturnType<typeof buildExecuteRequest>,
): Promise<ApiResult<ExecutionResponse>> {
  return chrome.runtime.sendMessage(request) as Promise<
    ApiResult<ExecutionResponse>
  >;
}

/**
 * The confirm->execute flow (Req 9.1, 11.1-11.5). On confirm it:
 *  1. resolves the current Integration's execution key (Req 9.2-9.5);
 *  2. POSTs to the Execute_API via the worker with the user body/headers +
 *     Bearer (Req 11.1);
 *  3. maps the response to an ExecutionOutcome capturing the messageId and
 *     displaying status/timestamp (Req 11.2), reporting "triggered, no tracking
 *     id" when none is returned (Req 11.3), or the 401 / could-not-trigger
 *     messages (Req 11.4, 11.5).
 *
 * When no key resolves (or key retrieval fails) it returns the KeySelectionOutcome
 * so the caller can surface that message and keep triggering disabled (Req 9.3-9.5).
 */
async function confirmExecution(
  context: ActiveBuilderContext,
  payload: { body: unknown; headers: Record<string, string> },
): Promise<ExecutionOutcome | KeySelectionOutcome> {
  const keyResult = await requestKeys();
  const keyOutcome = resolveKeySelection(
    keyResult,
    context.id,
    context.diagramId,
  );
  if (!keyOutcome.ok) {
    return keyOutcome;
  }

  const request = buildExecuteRequest(
    context.id,
    keyOutcome.key,
    payload.body,
    payload.headers,
  );
  const execResult = await requestExecute(request);
  return resolveExecutionOutcome(execResult, keyOutcome.key);
}

// ---------------------------------------------------------------------------
// Execution tracking (Req 12-15)
// ---------------------------------------------------------------------------

/**
 * Opens the tracking Port and drives the tracking UI from the streamed step
 * state (Req 12.2). After a successful execution with a captured messageId
 * (Req 11.2) this:
 *  1. connects the long-lived Port (chrome.runtime.connect, TRACK_PORT_NAME);
 *  2. sends TRACK_START with the messageId + integrationId (Req 12.1);
 *  3. renders each streamed PortResponse textually and, best-effort, highlights
 *     the executed path on the canvas (Req 15.1). A missing node never breaks
 *     the textual tracking (Req 15.3).
 *
 * The Port disconnects (-> worker TRACK_STOP) once a terminal/unauthorized
 * update arrives, so polling stops when there is nothing left to show.
 */
/**
 * The Tracking_Modal handle: a themed modal with a global summary + spinner, a
 * meta line (execution time / components), and a live step list (Req 12.7-12.9).
 */
interface TrackingModalHandle {
  overlay: HTMLElement;
  setSummary(text: string, loading: boolean): void;
  setMeta(text: string): void;
  setMessageId(messageId: string): void;
  renderSteps(steps: ExecutionStep[]): void;
  renderChildren(children: Message[], total: number): void;
  close(): void;
}

/** Masks Authorization/Bearer token values in a headers object (Req 13.6, 17). */
function maskHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") {
    return headers;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const isAuth = /authorization/i.test(k);
    if (isAuth) {
      out[k] = "«masked»";
    } else if (typeof v === "string" && /^Bearer\s+/i.test(v)) {
      out[k] = "Bearer «masked»";
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Pretty-prints a step payload (JSON when possible), masking tokens. */
function formatPayload(value: unknown, isHeaders: boolean): string {
  const v = isHeaders ? maskHeaders(value) : value;
  if (v === undefined || v === null) {
    return "—";
  }
  if (typeof v === "string") {
    // Try to pretty-print embedded JSON strings (e.g. inMessage).
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Builds a spinner element (Req 12.8). */
function spinner(onDark = false): HTMLElement {
  // The official iPaaS "greySpinner" mark (16x16 SVG) rotated 360deg, matching
  // projects/.../spinner-loading. Inlined so the extension needs no asset.
  const el = document.createElement("span");
  el.className = onDark
    ? "ipaas-helper-spinner ipaas-helper-spinner--on-dark"
    : "ipaas-helper-spinner";
  const color = onDark ? "#ffffff" : "#58595B";
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M7.3929 4.3638C7.3929 4.69713 7.66563 4.96986 7.99896 4.96986C8.3323 4.96986 8.60502 4.69713 8.60502 4.3638V1.93956C8.60502 1.60622 8.3323 1.3335 7.99896 1.3335C7.66563 1.3335 7.3929 1.60622 7.3929 1.93956V4.3638ZM7.3929 14.0611C7.3929 14.3944 7.66563 14.6671 7.99896 14.6671C8.3323 14.6671 8.60502 14.3944 8.60502 14.0611V11.6368C8.60502 11.3035 8.3323 11.0308 7.99896 11.0308C7.66563 11.0308 7.3929 11.3035 7.3929 11.6368V14.0611ZM5.42917 6.03682C5.2716 6.03682 5.12008 5.97622 4.99887 5.86106L3.28372 4.14591C3.04735 3.90955 3.04735 3.52773 3.28372 3.29137C3.52008 3.055 3.9019 3.055 4.13826 3.29137L5.85342 5.00652C6.08978 5.24288 6.08978 5.6247 5.85342 5.86106C5.73826 5.97622 5.58675 6.03682 5.42917 6.03682ZM11.853 12.7152C11.9742 12.8304 12.1258 12.891 12.2833 12.891C12.4409 12.891 12.5924 12.8304 12.7076 12.7152C12.9439 12.4789 12.9439 12.097 12.7076 11.8607L10.9924 10.1455C10.7561 9.90917 10.3742 9.90917 10.1379 10.1455C9.90152 10.3819 9.90152 10.7637 10.1379 11.0001L11.853 12.7152ZM4.36331 8.60616H1.93907C1.60574 8.60616 1.33301 8.33344 1.33301 8.0001C1.33301 7.66677 1.60574 7.39404 1.93907 7.39404H4.36331C4.69664 7.39404 4.96937 7.66677 4.96937 8.0001C4.96937 8.33344 4.69664 8.60616 4.36331 8.60616ZM11.637 8.60616H14.0612C14.3946 8.60616 14.6673 8.33344 14.6673 8.0001C14.6673 7.66677 14.3946 7.39404 14.0612 7.39404H11.637C11.3037 7.39404 11.0309 7.66677 11.0309 8.0001C11.0309 8.33344 11.3037 8.60616 11.637 8.60616ZM3.71402 12.891C3.55645 12.891 3.40493 12.8304 3.28372 12.7152C3.04735 12.4789 3.04735 12.097 3.28372 11.8607L4.99887 10.1455C5.23523 9.90917 5.61705 9.90917 5.85342 10.1455C6.08978 10.3819 6.08978 10.7637 5.85342 11.0001L4.13826 12.7152C4.02311 12.8304 3.8716 12.891 3.71402 12.891ZM10.1379 5.86106C10.2591 5.97622 10.4106 6.03682 10.5682 6.03682C10.7258 6.03682 10.8773 5.97622 10.9924 5.86106L12.7076 4.14591C12.9439 3.90955 12.9439 3.52773 12.7076 3.29137C12.4712 3.055 12.0894 3.055 11.853 3.29137L10.1379 5.00652C9.90152 5.24288 9.90152 5.6247 10.1379 5.86106Z" fill="' +
    color +
    '"/></svg>';
  return el;
}

/** Opens the Tracking_Modal centered over the page (Req 12.7). */
function openTrackingModal(onRerun?: () => void): TrackingModalHandle {
  ensureStyles();

  const overlay = document.createElement("div");
  overlay.className = "ipaas-helper-modal-overlay ipaas-helper-modal-overlay--track";

  const dialog = document.createElement("div");
  dialog.className = "ipaas-helper-modal ipaas-helper-modal--track";
  overlay.appendChild(dialog);

  const header = document.createElement("div");
  header.className = "ipaas-helper-modal-header";
  const htitle = document.createElement("span");
  htitle.textContent = "Acompanhamento da execução";
  const headerActions = document.createElement("div");
  headerActions.className = "ipaas-helper-modal-actions";
  // "Executar novamente": closes this tracking modal and reopens the
  // pre-execution dialog so the user can tweak the payload and run again.
  if (onRerun) {
    const rerun = document.createElement("button");
    rerun.type = "button";
    rerun.className = "ipaas-helper-modal-rerun";
    rerun.textContent = "▶ Executar novamente";
    rerun.title = "Abrir a tela de execução novamente";
    rerun.addEventListener("click", () => {
      handle.close();
      onRerun();
    });
    headerActions.appendChild(rerun);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ipaas-helper-modal-close";
  close.textContent = "×";
  headerActions.appendChild(close);
  header.append(htitle, headerActions);
  dialog.appendChild(header);

  const body = document.createElement("div");
  body.className = "ipaas-helper-modal-body";
  dialog.appendChild(body);

  const summary = document.createElement("div");
  summary.className = "ipaas-helper-track-summary";
  const idLine = document.createElement("div");
  idLine.className = "ipaas-helper-track-id";
  const meta = document.createElement("div");
  meta.className = "ipaas-helper-track-meta";
  const stepsList = document.createElement("ul");
  stepsList.className = "ipaas-helper-steps";
  const childrenBox = document.createElement("div");
  childrenBox.className = "ipaas-helper-children";
  body.append(summary, idLine, meta, stepsList, childrenBox);

  document.body.appendChild(overlay);

  const handle: TrackingModalHandle = {
    overlay,
    setSummary(text, loading) {
      summary.textContent = "";
      if (loading) summary.appendChild(spinner());
      const label = document.createElement("span");
      label.textContent = text;
      summary.appendChild(label);
    },
    setMeta(text) {
      meta.textContent = text;
    },
    setMessageId(messageId) {
      idLine.textContent = "";
      const caption = document.createElement("span");
      caption.textContent = "Message_Id: ";
      const link = document.createElement("a");
      link.className = "ipaas-helper-track-link";
      link.href = `https://ipaas.totvs.app/message/${messageId}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = messageId;
      idLine.append(caption, link);
    },
    renderSteps(steps) {
      // Preserve which steps the user expanded across re-renders (polling).
      const openIds = new Set(
        Array.from(stepsList.querySelectorAll<HTMLElement>(".ipaas-helper-step.open"))
          .map((el) => el.dataset.stepKey ?? ""),
      );
      stepsList.textContent = "";

      steps.forEach((step, i) => {
        const key = `${step.componentId ?? ""}#${i}`;
        const li = document.createElement("li");
        li.className = "ipaas-helper-step";
        li.dataset.stepKey = key;

        // Header row (clickable to expand) — Req 13.5.
        const headerRow = document.createElement("div");
        headerRow.className = "ipaas-helper-step-header";

        const caret = document.createElement("span");
        caret.className = "ipaas-helper-step-caret";
        caret.textContent = "▸";

        const label = document.createElement("span");
        label.className = "ipaas-helper-step-label";
        const stepAny = step as unknown as {
          componentDTO?: { name?: string };
          resourceType?: string;
          condition?: { expression?: string; result?: unknown };
        };
        const isCondition =
          stepAny.resourceType === "CONDITION" ||
          stepAny.resourceType === "OTHERWISE" ||
          !!stepAny.condition;
        label.textContent =
          step.activityLabel || stepAny.componentDTO?.name || step.componentId;
        // Make it explicit when a step is a condition branch (Req 7, 15).
        if (isCondition) {
          const tag = document.createElement("span");
          tag.className = "ipaas-helper-step-cond-tag";
          tag.textContent =
            stepAny.resourceType === "OTHERWISE" ? "senão" : "condição";
          label.appendChild(tag);
        }

        const status = step.status;
        const badge = document.createElement("span");
        if (status === "DONE") {
          badge.className = "ipaas-helper-step-badge done";
          badge.textContent = "Concluído";
        } else if (status === "ERROR") {
          badge.className = "ipaas-helper-step-badge error";
          badge.textContent = "Erro";
        } else {
          badge.className = "ipaas-helper-step-badge processing";
          badge.textContent = "Processando";
        }

        headerRow.append(caret, label);
        if (status === "PROCESSING") headerRow.appendChild(spinner());
        headerRow.appendChild(badge);
        li.appendChild(headerRow);

        // Detail (payloads) — Req 13.5, masked headers — Req 13.6.
        const detail = document.createElement("div");
        detail.className = "ipaas-helper-step-detail";
        // Condition steps: surface the evaluated expression and its result so
        // it is clear this step is a branch decision, not a data activity.
        if (isCondition && stepAny.condition) {
          const h = document.createElement("div");
          h.className = "ipaas-helper-step-detail-title";
          h.textContent = "Condição avaliada";
          const box = document.createElement("div");
          box.className = "ipaas-helper-step-cond";
          const expr = stepAny.condition.expression ?? "—";
          const res = stepAny.condition.result;
          const resText =
            res === true ? "verdadeiro" : res === false ? "falso" : String(res ?? "—");
          box.textContent = `${expr} → ${resText}`;
          detail.append(h, box);
        }
        const sections: Array<[string, unknown, boolean]> = [
          ["Entrada (inMessage)", (step as ExecutionStep).inMessage, false],
          ["Saída (outMessage)", (step as ExecutionStep).outMessage, false],
          ["Headers de entrada", (step as ExecutionStep).inHeaders, true],
          ["Headers de saída", (step as ExecutionStep).outHeaders, true],
        ];
        for (const [title, val, isHeaders] of sections) {
          const h = document.createElement("div");
          h.className = "ipaas-helper-step-detail-title";
          h.textContent = title;
          const pre = document.createElement("pre");
          pre.className = "ipaas-helper-step-pre";
          pre.textContent = formatPayload(val, isHeaders);
          detail.append(h, pre);
        }
        const times = document.createElement("div");
        times.className = "ipaas-helper-step-times";
        times.textContent = `${(step as ExecutionStep).startDate ?? ""} → ${(step as ExecutionStep).endDate ?? "—"}`;
        detail.appendChild(times);
        li.appendChild(detail);

        // Expand/collapse wiring; restore prior open state.
        const setOpen = (open: boolean): void => {
          li.classList.toggle("open", open);
          caret.textContent = open ? "▾" : "▸";
          detail.style.display = open ? "block" : "none";
        };
        setOpen(openIds.has(key));
        headerRow.addEventListener("click", () =>
          setOpen(!li.classList.contains("open")),
        );

        stepsList.appendChild(li);
      });
    },
    renderChildren(children, total) {
      childrenBox.textContent = "";
      if (!total || total <= 0) return;

      const done = children.filter((c) => c.status === "DONE").length;
      const error = children.filter((c) => c.status === "ERROR").length;
      const processing = children.filter((c) => c.status === "PROCESSING").length;

      const heading = document.createElement("div");
      heading.className = "ipaas-helper-section-title";
      heading.textContent = `Mensagens filhas (${children.length} de ${total})`;
      childrenBox.appendChild(heading);

      const agg = document.createElement("div");
      agg.className = "ipaas-helper-children-agg";
      agg.textContent = `${done} concluídas · ${error} com erro · ${processing} em processamento`;
      childrenBox.appendChild(agg);

      const list = document.createElement("ul");
      list.className = "ipaas-helper-children-list";
      for (const child of children) {
        const li = document.createElement("li");
        li.className = "ipaas-helper-child";
        const link = document.createElement("a");
        link.className = "ipaas-helper-track-link";
        link.href = `https://ipaas.totvs.app/message/${child.id}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = child.id;
        const badge = document.createElement("span");
        const st = child.status;
        badge.className =
          "ipaas-helper-step-badge " +
          (st === "DONE" ? "done" : st === "ERROR" ? "error" : "processing");
        badge.textContent =
          st === "DONE" ? "Concluído" : st === "ERROR" ? "Erro" : "Processando";
        li.append(link, badge);
        list.appendChild(li);
      }
      if (total > children.length) {
        const more = document.createElement("div");
        more.className = "ipaas-helper-empty";
        more.textContent = `+ ${total - children.length} outras não listadas`;
        childrenBox.append(list, more);
      } else {
        childrenBox.appendChild(list);
      }
    },
    close() {
      overlay.remove();
    },
  };

  close.addEventListener("click", () => handle.close());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) handle.close();
  });

  return handle;
}

/**
 * Opens the tracking Port and drives the Tracking_Modal from the streamed step
 * state (Req 12). Connects the long-lived Port, sends TRACK_START, and on each
 * PortResponse updates the modal summary/meta/steps, keeps a global spinner
 * until a Terminal_State, and best-effort highlights the executing node on the
 * canvas (Req 15.1; a missing node never breaks the modal, Req 15.3).
 */
function startTracking(
  context: ActiveBuilderContext,
  messageId: string,
  modal: TrackingModalHandle,
): void {
  const highlighter = new DomCanvasHighlighter();
  // Clear any highlight left over from a previous execution before painting the
  // new path, so re-running does not accumulate the old path's colors. The
  // previous run's clearAll fires on its port disconnect, but a new run may
  // start before that lands; clearing by class here is idempotent and safe.
  highlighter.clearAll();
  const port = chrome.runtime.connect({ name: TRACK_PORT_NAME });

  // The Steps_API does not carry the canvas node id; resolve each step to its
  // DOM node via the flow (primarily by activityLabel). See buildStepNodeIndex.
  //
  // Re-fetch the flow NOW instead of reusing the one captured at activation:
  // publishing the diagram reloads a new flow version server-side (new activity
  // keys/labels) without a page reload, so the activation-time flow can be
  // stale. The index is rebuilt from the fresh flow once it arrives; until then
  // the captured flow is used so early steps still resolve. A failed re-fetch
  // keeps the captured flow (best-effort, Req 15.3).
  let nodeIndex = buildStepNodeIndex(context.flow);
  void requestFlow(context.diagramId).then((result) => {
    if (result.ok && result.data?.flow) {
      nodeIndex = buildStepNodeIndex(result.data.flow);
      highlighter.clearAll();
    }
  });

  // Reads a step's `inHeaders.activityId` (the exact canvas DOM node id). This
  // is the most reliable source: the node exists on the canvas as soon as it is
  // drawn, regardless of whether the diagram was published, so it works even
  // when the fetched flow is a stale (published) snapshot that lacks a just-
  // added node.
  const headerActivityId = (step: {
    inHeaders?: unknown;
    outHeaders?: unknown;
  }): string | null => {
    for (const headers of [step.inHeaders, step.outHeaders]) {
      if (headers && typeof headers === "object") {
        const v = (headers as Record<string, unknown>).activityId;
        if (typeof v === "string" && v !== "") return v;
      }
    }
    return null;
  };

  const highlightSteps = (
    steps: Array<{
      componentId?: string;
      activityLabel?: string;
      status: string;
      inHeaders?: unknown;
      outHeaders?: unknown;
    }>,
  ): void => {
    for (const step of steps) {
      try {
        // Prefer the header activityId resolved against the LIVE DOM; fall back
        // to the flow index (label/componentId) only when it is absent or the
        // node is not on the canvas.
        const headerId = headerActivityId(step);
        const nodeId =
          headerId && document.getElementById(headerId)
            ? headerId
            : resolveStepNodeId(step, nodeIndex);
        if (!nodeId) continue;
        highlighter.highlight(
          nodeId,
          step.status as Parameters<CanvasHighlighter["highlight"]>[1],
        );
      } catch {
        // Best-effort: a missing node never breaks the modal (Req 15.3).
      }
    }
  };

  port.onMessage.addListener((message: unknown) => {
    const response = message as PortResponse;
    switch (response.type) {
      case "UPDATE":
        modal.setSummary(`Status ${response.status}`, true);
        modal.setMeta(
          `${response.executionTime}ms — ${response.initialComponent} → ${response.finalComponent}`,
        );
        modal.renderSteps(response.steps);
        if (response.children && response.childTotal) {
          modal.renderChildren(response.children, response.childTotal);
        }
        highlightSteps(response.steps);
        break;
      case "TERMINAL":
        modal.setSummary(`Execução concluída — ${response.status}`, false);
        modal.renderSteps(response.steps);
        if (response.children && response.childTotal) {
          modal.renderChildren(response.children, response.childTotal);
        }
        highlightSteps(response.steps);
        port.disconnect();
        break;
      case "UNAUTHORIZED":
        modal.setSummary(
          "Sua sessão expirou. Capture a sessão novamente.",
          false,
        );
        port.disconnect();
        break;
      case "TRANSIENT_ERROR":
        // Keep the last data and the spinner; polling continues (Req 12.6).
        break;
    }
  });

  port.onDisconnect.addListener(() => highlighter.clearAll());

  const start: TrackStartMessage = {
    type: "TRACK_START",
    messageId,
    integrationId: context.id,
  };
  port.postMessage(start);
}

const STYLE_ID = "ipaas-helper-styles";

/**
 * Injects the helper stylesheet once. Styling intentionally inherits the host
 * page's font and mirrors the iPaaS visual language (primary blue, light
 * surface, subtle borders) so the panel reads as part of the product. All rules
 * are scoped under #ipaas-helper-root to avoid leaking into the page.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${CONTAINER_ID} {
  --ih-primary: var(--ipaas-color, #045B8F);
  --ih-primary-2: var(--ipaas-second-color, #12A2F7);
  --ih-text: var(--neutral-dark, #58595b);
  --ih-border: var(--neutral-ultra-light, #E8E9EB);
  --ih-surface: var(--neutral-white, #ffffff);
  --ih-muted: var(--neutral-medium, #AFB0B3);
  position: fixed;
  top: 72px;
  right: 16px;
  z-index: 2147483000;
  width: 360px;
  max-height: calc(100vh - 96px);
  overflow: auto;
  background: var(--ih-surface);
  color: var(--ih-text);
  font-family: Inter, "Open Sans", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  border: 1px solid var(--ih-border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
}
#${CONTAINER_ID}[data-active="false"] { padding: 12px 14px; }
#${CONTAINER_ID} .ipaas-helper-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  background: var(--ih-primary);
  color: #ffffff;
  font-weight: 600;
  font-size: 15px;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  user-select: none;
}
#${CONTAINER_ID}.ipaas-helper-collapsed { width: auto; }
#${CONTAINER_ID}.ipaas-helper-collapsed .ipaas-helper-header { border-radius: 4px; }
#${CONTAINER_ID} .ipaas-helper-header-title { display: inline-flex; align-items: center; gap: 6px; }
#${CONTAINER_ID} .ipaas-helper-header-caret { font-size: 10px; opacity: 0.9; }
#${CONTAINER_ID} .ipaas-helper-integration-name { color: rgba(255,255,255,0.85) !important; }
#${CONTAINER_ID} .ipaas-helper-body { padding: 12px 14px; }
#${CONTAINER_ID} .ipaas-helper-section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ih-muted);
  margin: 10px 0 4px;
}
#${CONTAINER_ID} .ipaas-helper-empty { color: var(--ih-muted); font-style: italic; }
#${CONTAINER_ID} ul { margin: 0; padding-left: 16px; }
#${CONTAINER_ID} .ipaas-helper-execute-button {
  margin-top: 12px;
  width: 100%;
  padding: 9px 12px;
  font: inherit;
  font-weight: 600;
  color: #ffffff;
  background: var(--ih-primary);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: filter 0.15s ease;
}
#${CONTAINER_ID} .ipaas-helper-execute-button:hover { filter: brightness(1.1); }
#${CONTAINER_ID} .ipaas-helper-status-message {
  margin-top: 8px;
  padding: 6px 8px;
  background: var(--ih-border);
  border-radius: 4px;
}
/* Trigger overlay button, anchored over the start node (Req 8.1, Trigger_Overlay) */
.ipaas-helper-trigger-overlay {
  position: fixed;
  z-index: 2147483646;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-family: Inter, "Open Sans", sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff !important;
  background: var(--ipaas-color, #045B8F);
  border: none;
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  cursor: pointer;
  transition: filter 0.15s ease;
}
.ipaas-helper-trigger-overlay:hover { filter: brightness(1.12); }
/* Modal overlay + dialog (execution + tracking), themed to iPaaS */
.ipaas-helper-modal-overlay {
  position: fixed; inset: 0; z-index: 2147483600;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  font-family: Inter, "Open Sans", sans-serif; font-size: 13px; color: #58595b;
}
.ipaas-helper-modal {
  width: 760px; max-width: calc(100vw - 48px); height: calc(100vh - 80px); max-height: calc(100vh - 80px);
  display: flex; flex-direction: column;
  overflow: hidden; background: #ffffff; color: #1a1a1a; border-radius: 6px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.3);
}
/* Tracking modal: anchored to the LEFT with a transparent, click-through
   backdrop so the canvas stays visible (and pannable) behind it while the
   execution path lights up (Req 15). */
.ipaas-helper-modal-overlay--track {
  justify-content: flex-start; align-items: center;
  background: transparent; pointer-events: none; padding-left: 16px;
}
.ipaas-helper-modal-overlay--track .ipaas-helper-modal--track {
  pointer-events: auto;
  width: 460px; max-width: calc(50vw - 24px);
}
.ipaas-helper-modal .ipaas-helper-modal-body { flex: 1; overflow: auto; }
.ipaas-helper-modal-body, .ipaas-helper-modal-body * { color: #1a1a1a; }
.ipaas-helper-track-id { margin-bottom: 10px; font-size: 12px; color: #58595b; }
.ipaas-helper-track-id .ipaas-helper-track-link {
  color: var(--ipaas-second-color, #12A2F7) !important; text-decoration: underline; word-break: break-all;
}
.ipaas-helper-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; background: var(--ipaas-color, #045B8F); color: #fff; font-weight: 600;
}
.ipaas-helper-modal-close {
  background: transparent; border: none; color: #fff; font-size: 18px; cursor: pointer; line-height: 1;
}
.ipaas-helper-modal-actions { display: flex; align-items: center; gap: 10px; }
.ipaas-helper-modal-rerun {
  background: rgba(255,255,255,0.16); border: 1px solid rgba(255,255,255,0.5);
  color: #fff !important; font-size: 12px; font-weight: 600; cursor: pointer;
  padding: 4px 10px; border-radius: 4px; line-height: 1.2; white-space: nowrap;
}
.ipaas-helper-modal-rerun:hover { background: rgba(255,255,255,0.28); }
.ipaas-helper-modal-body { padding: 16px; }
.ipaas-helper-track-summary {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  font-weight: 600; color: #1a1a1a;
}
.ipaas-helper-track-meta { color: #8a8a8a; font-weight: 400; font-size: 12px; margin-bottom: 12px; }
.ipaas-helper-steps { list-style: none; margin: 0; padding: 0; }
.ipaas-helper-step {
  display: block; padding: 0; border: 1px solid #e8e9eb; border-radius: 4px; margin-bottom: 6px;
}
.ipaas-helper-step-header {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
}
.ipaas-helper-step-header:hover { background: #f8f9fa; }
.ipaas-helper-step-caret { color: #8a8a8a; width: 12px; flex: none; }
.ipaas-helper-step-label { flex: 1; display: flex; align-items: center; gap: 8px; }
.ipaas-helper-step-cond-tag {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 1px 7px; border-radius: 999px; background: #ede7f6; color: #5e35b1;
}
.ipaas-helper-step-cond {
  margin: 0 0 2px; padding: 8px; background: #f6f2fb; border: 1px solid #e3d9f3;
  border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; color: #4527a0;
}
.ipaas-helper-step-detail { display: none; padding: 4px 10px 10px 28px; border-top: 1px solid #f0f1f3; }
.ipaas-helper-step-detail-title { font-size: 11px; font-weight: 600; color: #8a8a8a; margin: 8px 0 2px; }
.ipaas-helper-step-pre {
  margin: 0; padding: 8px; background: #f4f6f8; border-radius: 4px;
  font-family: ui-monospace, monospace; font-size: 11px; color: #1a1a1a;
  white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto;
}
.ipaas-helper-step-times { margin-top: 8px; font-size: 11px; color: #8a8a8a; }
.ipaas-helper-children { margin-top: 14px; }
.ipaas-helper-children-agg { font-size: 12px; color: #58595b; margin-bottom: 6px; }
.ipaas-helper-children-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ipaas-helper-child { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid #e8e9eb; border-radius: 4px; }
.ipaas-helper-child .ipaas-helper-track-link { color: var(--ipaas-second-color, #12A2F7) !important; word-break: break-all; }
#${CONTAINER_ID} .ipaas-helper-hoverable { cursor: pointer; border-radius: 4px; }
#${CONTAINER_ID} .ipaas-helper-hoverable:hover { background: #eef5fb; }
#${CONTAINER_ID} .ipaas-helper-function-origins { list-style: none; margin: 0; padding: 0; }
#${CONTAINER_ID} .ipaas-helper-function-origin { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; }
#${CONTAINER_ID} .ipaas-helper-function-name { font-weight: 600; color: #1a1a1a; }
#${CONTAINER_ID} .ipaas-helper-splitter-tag {
  display: inline-block; margin-left: 6px; vertical-align: middle;
  font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 1px 6px; border-radius: 999px; background: #e3d9f3; color: #5e35b1;
}
#${CONTAINER_ID} .ipaas-helper-function-app { font-size: 12px; color: var(--ih-primary); }
#${CONTAINER_ID} .ipaas-helper-function-origin.ipaas-helper-unused { opacity: 0.6; }
#${CONTAINER_ID} .ipaas-helper-function-origin.ipaas-helper-unused .ipaas-helper-function-app { color: var(--ih-muted); font-style: italic; }
#${CONTAINER_ID} .ipaas-helper-condition-summary { padding: 6px 8px; border-left: 3px solid var(--ih-primary); margin: 4px 0; }
#${CONTAINER_ID} .ipaas-helper-condition-summary.ipaas-helper-condition-else { border-left-color: var(--ih-muted); }
#${CONTAINER_ID} .ipaas-helper-condition-type { font-weight: 600; color: #1a1a1a; }
#${CONTAINER_ID} .ipaas-helper-condition-clauses { list-style: none; margin: 2px 0 0; padding: 0; }
#${CONTAINER_ID} .ipaas-helper-condition-clause { font-size: 12px; color: #58595b; word-break: break-word; }
#${CONTAINER_ID} .ipaas-helper-condition-empty { font-size: 12px; color: var(--ih-muted); font-style: italic; }
/* Canvas node highlight on hover — applied to the builder's own node elements,
   so it is NOT scoped under the panel. Strong ring so it stands out. */
.ipaas-helper-node-hover {
  outline: 3px solid var(--ipaas-color, #045B8F) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(4,91,143,0.35), 0 0 16px 4px rgba(18,162,247,0.55) !important;
  border-radius: 6px !important;
  transition: box-shadow 0.1s ease !important;
  z-index: 5 !important;
}
.ipaas-helper-step-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.ipaas-helper-step-badge.done { background: #e6f7ec; color: #1AB83F !important; }
.ipaas-helper-step-badge.error { background: #fdecea; color: #c0392b !important; }
.ipaas-helper-step-badge.processing { background: #e8f3fb; color: #045B8F !important; }
/* Spinner — official iPaaS greySpinner mark, rotating 360deg (2s linear) */
.ipaas-helper-spinner {
  display: inline-flex; width: 16px; height: 16px; flex: none; line-height: 0;
}
.ipaas-helper-spinner svg {
  width: 16px; height: 16px;
  animation: ipaas-helper-spin 2s linear infinite;
}
@keyframes ipaas-helper-spin { to { transform: rotate(360deg); } }
/* Execution modal (body + headers) — themed to match the iPaaS language */
.ipaas-exec-modal-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  font-family: Inter, "Open Sans", sans-serif; font-size: 13px; color: #58595b;
}
.ipaas-exec-modal {
  width: 620px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px);
  overflow: auto; background: #fff; border-radius: 6px; padding: 16px;
  box-shadow: 0 12px 48px rgba(0,0,0,0.3);
  display: flex; flex-direction: column; gap: 6px;
}
.ipaas-exec-modal label { font-weight: 600; font-size: 12px; color: #3a3a3a; }
.ipaas-exec-modal textarea {
  width: 100%; box-sizing: border-box; min-height: 120px; margin-bottom: 4px;
  font-family: ui-monospace, monospace; font-size: 12px;
  border: 1px solid #e8e9eb; border-radius: 4px; padding: 8px; resize: vertical;
}
.ipaas-exec-modal-error { color: #c0392b; font-size: 12px; min-height: 14px; }
.ipaas-exec-modal-confirm, .ipaas-exec-modal-cancel {
  font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 4px;
  cursor: pointer; border: 1px solid transparent;
}
.ipaas-exec-modal-confirm { color: #ffffff !important; background: var(--ipaas-color, #045B8F); margin-top: 6px; }
.ipaas-exec-modal-confirm:hover { filter: brightness(1.1); }
.ipaas-exec-modal-confirm:disabled { background: #AFB0B3; cursor: not-allowed; filter: none; }
.ipaas-exec-modal-cancel { background: #fff; color: #58595b; border-color: #e8e9eb; }
`;
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * Returns the extension's floating panel, creating it (with a header + body)
 * on first use and injecting the stylesheet. The panel is fixed to the top-right
 * of the builder so it stays visible over the canvas.
 */
function ensureContainer(): HTMLElement {
  ensureStyles();
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Handles CAPTURE_TOKEN from the popup: reads this tab's `document.cookie` and
 * replies with the token (Req 2.2). The popup/worker persist it in the
 * Session_Store. Registered on every iPaaS page, not just the builder.
 */
function registerCaptureListener(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((message as { type?: string } | null)?.type === "CAPTURE_TOKEN") {
      const token = readJwtFromDocumentCookie();
      sendResponse({ token } as CaptureTokenResponse);
      return true; // keep the channel open for the sync reply
    }
    return undefined;
  });
}

// Bootstrap. The capture listener runs on every iPaaS page so the popup can
// capture from the active tab; builder activation only proceeds on /builder/*.
// Guarded so importing this module in a non-DOM test environment does not run.
if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  registerCaptureListener();
  void activate();
}
