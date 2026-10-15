// SessionPanel popup entry point (Req 2, 3, 4, 16).
//
// Responsibilities:
//  1. Ask the trusted service worker to decode the session JWT (GET_SESSION)
//     and, when it decodes, resolve the effective role (GET_ROLE) keyed by the
//     derived User_Code/Tenant_Code (Req 4.1, 4.2).
//  2. Turn the responses into a plain view-model with the pure logic in
//     ./popup/render.ts, then paint that view-model into the DOM here.
//
// All branch selection lives in ./popup/render.ts so it stays unit-testable;
// this file only does messaging and DOM painting.

import type { Role } from "./models";
import type { HistoryEntry } from "./history";
import type {
  ApiResult,
  GetRoleRequest,
  GetSessionRequest,
  SessionResponse,
} from "./messaging/protocol";
import { deriveCodes, NOT_AVAILABLE } from "./popup/session-view";
import {
  buildPopupView,
  type PopupView,
  type RoleSection,
  type SessionSection,
} from "./popup/render";

// ---------------------------------------------------------------------------
// User-facing messages (one place so copy stays consistent across branches).
// ---------------------------------------------------------------------------

const MESSAGES = {
  noSession: "No active session was found.",
  malformedStructure: "The session token structure is malformed.",
  payloadNotJson: "The session token payload could not be decoded.",
  reauth: "Your session is unauthorized or expired. Please re-authenticate.",
  roleUnavailable: "The role could not be retrieved.",
  roleNotFound:
    "No role was found for the current user and tenant.",
} as const;

// ---------------------------------------------------------------------------
// Worker messaging
// ---------------------------------------------------------------------------

/** Asks the worker to capture the token from the active iPaaS tab (Req 2.2). */
async function requestCapture(): Promise<{ token: string | null }> {
  return chrome.runtime.sendMessage({ type: "CAPTURE_TOKEN" }) as Promise<{
    token: string | null;
  }>;
}

/** Reads the Execution_History from the worker (Req 19.3). */
async function requestHistory(): Promise<HistoryEntry[]> {
  const res = (await chrome.runtime.sendMessage({ type: "GET_HISTORY" })) as {
    entries?: HistoryEntry[];
  };
  return res?.entries ?? [];
}

/** Renders the Execution_History section (Req 19.3-19.5). */
function renderHistory(root: HTMLElement, entries: HistoryEntry[]): void {
  const section = document.createElement("section");
  section.className = "history-section";

  const heading = document.createElement("h3");
  heading.className = "features-heading";
  heading.textContent = "Execuções recentes";
  section.appendChild(heading);

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "not-available";
    empty.textContent = "Nenhuma execução recente.";
    section.appendChild(empty);
    root.appendChild(section);
    return;
  }

  const list = document.createElement("ul");
  list.className = "history-list";
  for (const e of entries) {
    const item = document.createElement("li");
    item.className = "history-item";

    const link = document.createElement("a");
    link.className = "history-link";
    const url = `https://ipaas.totvs.app/message/${e.messageId}`;
    link.href = url;
    // Open via chrome.tabs so the tab lands in the SAME window/profile as the
    // popup (an <a target=_blank> from an incognito popup would open a normal
    // window). currentWindow keeps it in the active (incognito) window.
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      chrome.tabs.create({ url });
    });
    // The Message_Id is the link label (Req 19.4); the integration name, status
    // and time go in the meta line below.
    link.textContent = e.messageId;

    const meta = document.createElement("span");
    meta.className = "history-meta";
    const when = new Date(e.timestamp);
    const whenText = Number.isNaN(when.getTime())
      ? e.timestamp
      : when.toLocaleString();
    const name = e.integrationName ? `${e.integrationName} · ` : "";
    meta.textContent = `${name}${e.status} · ${whenText}`;

    item.append(link, meta);
    list.appendChild(item);
  }
  section.appendChild(list);
  root.appendChild(section);
}

/** Requests the decoded session from the worker (Req 2). */
async function requestSession(): Promise<SessionResponse> {
  const request: GetSessionRequest = { type: "GET_SESSION" };
  return chrome.runtime.sendMessage(request) as Promise<SessionResponse>;
}

/** Requests the effective role from the worker for the derived codes (Req 4.2). */
async function requestRole(
  userCode: string,
  tenantCode: string,
): Promise<ApiResult<Role>> {
  const request: GetRoleRequest = { type: "GET_ROLE", userCode, tenantCode };
  return chrome.runtime.sendMessage(request) as Promise<ApiResult<Role>>;
}

/**
 * Loads the full popup view-model: decode the session, then (only when it
 * decodes) resolve the role for the derived codes. `now` is injected for
 * deterministic expiration classification.
 */
export async function loadPopupView(now: number = Date.now()): Promise<PopupView> {
  const session = await requestSession();
  let role: ApiResult<Role> | null = null;
  if (session.ok) {
    const { userCode, tenantCode } = deriveCodes(session.claims);
    role = await requestRole(userCode, tenantCode);
  }
  return buildPopupView(session, role, now);
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

/** Creates a `<div class="row"><span class="label"> <span class="value">`. */
function fieldRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "field-row";

  const labelEl = document.createElement("span");
  labelEl.className = "field-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "field-value";
  valueEl.textContent = value;
  if (value === NOT_AVAILABLE) {
    valueEl.classList.add("not-available");
  }

  row.append(labelEl, valueEl);
  return row;
}

/** Creates a status/message line with a modifier class for styling. */
function message(text: string, modifier: string): HTMLElement {
  const el = document.createElement("p");
  el.className = `message message-${modifier}`;
  el.textContent = text;
  return el;
}

/** Renders the decoded-session section into a container element. */
function renderSessionSection(section: SessionSection): HTMLElement {
  const container = document.createElement("section");
  container.className = "session-section";

  switch (section.kind) {
    case "no_session":
      container.append(message(MESSAGES.noSession, "no-session"));
      return container;
    case "malformed_structure":
      container.append(message(MESSAGES.malformedStructure, "error"));
      return container;
    case "payload_not_json":
      container.append(message(MESSAGES.payloadNotJson, "error"));
      return container;
    case "decoded": {
      const { view } = section;
      container.append(
        fieldRow("Company", view.company),
        fieldRow("User", view.user),
        fieldRow("Environment", view.env),
      );

      // Expiration: distinct indicator for expired vs active vs unavailable.
      const expValue =
        view.expiration.status === "unavailable" || view.expiration.display === null
          ? NOT_AVAILABLE
          : view.expiration.display;
      const expRow = fieldRow("Expiration", expValue);
      expRow.classList.add(`expiration-${view.expiration.status}`);
      container.append(expRow);
      return container;
    }
  }
}

/** Renders the role section into a container element. */
function renderRoleSection(section: RoleSection): HTMLElement {
  const container = document.createElement("section");
  container.className = "role-section";

  switch (section.kind) {
    case "none":
      // No decoded session; nothing to show for the role.
      return container;
    case "unauthorized":
      container.append(message(MESSAGES.reauth, "reauth"));
      return container;
    case "no_session":
      container.append(message(MESSAGES.noSession, "no-session"));
      return container;
    case "unavailable":
      container.append(message(MESSAGES.roleUnavailable, "error"));
      return container;
    case "not_found":
      container.append(message(MESSAGES.roleNotFound, "error"));
      return container;
    case "role": {
      container.append(
        fieldRow("Role", section.name),
        fieldRow("Type", section.type),
      );

      const heading = document.createElement("h3");
      heading.className = "features-heading";
      heading.textContent = "Features";
      container.append(heading);

      const list = document.createElement("ul");
      list.className = "feature-list";
      for (const name of section.features) {
        const item = document.createElement("li");
        item.className = "feature-item";
        item.textContent = name;
        list.append(item);
      }
      container.append(list);
      return container;
    }
  }
}

/** Paints the full view-model into the given root element. */
export function renderPopup(root: HTMLElement, view: PopupView): void {
  root.replaceChildren(
    renderSessionSection(view.session),
    renderRoleSection(view.role),
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Captures the session from the active iPaaS tab, then loads + paints the view. */
async function captureAndRender(root: HTMLElement, status?: HTMLElement): Promise<void> {
  if (status) status.textContent = "Capturando sessão...";
  const { token } = await requestCapture();

  if (token) {
    if (status) status.textContent = "";
    const view = await loadPopupView();
    renderPopup(root, view);
  } else {
    if (status) {
      status.textContent =
        "Nenhuma sessão encontrada. Abra o iPaaS em uma aba e tente novamente.";
    }
    // Clear any stale session view, but still show the history below.
    root.replaceChildren();
  }

  // Req 19.3 — always show the recent-executions history, with or without an
  // active session (it is independent of the current capture).
  const entries = await requestHistory();
  renderHistory(root, entries);
}

/**
 * Wires the "Capturar sessão" button and does an initial automatic capture so
 * the panel is populated as soon as it opens (while an iPaaS tab is active).
 */
async function bootstrap(): Promise<void> {
  const root = document.getElementById("session-panel");
  if (root === null) {
    return;
  }
  const button = document.getElementById("capture-button");
  const status = document.getElementById("capture-status") ?? undefined;
  if (button) {
    button.addEventListener("click", () => {
      void captureAndRender(root, status as HTMLElement | undefined);
    });
  }
  // Initial capture attempt on open (Req 2.2); if no iPaaS tab, the button lets
  // the user retry after opening one.
  await captureAndRender(root, status as HTMLElement | undefined);
}

// Only auto-run in a real document context (the tests import the helpers directly).
if (typeof document !== "undefined" && document.getElementById("session-panel")) {
  void bootstrap();
}
