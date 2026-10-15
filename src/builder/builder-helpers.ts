// BuilderHelpers: function-origin resolution, condition summaries, and the
// execute-button precondition (Req 6, 7, 8).
//
// The three resolvers are PURE functions over the Flow / Integration models so
// they stay unit- and property-testable. DOM rendering is kept in separate
// functions at the bottom of the file and never influences the resolvers.
import type { Flow, FlowActivity, FlowFunction, Integration } from "../models";

// Req 6 — one origin indicator per Flow_Function.
export type FunctionUsage = "node" | "function" | "unused";

export interface FunctionOrigin {
  functionId: string;
  functionName: string;
  originApp: string | null; // the consuming node's app label when usage==="node"
  /**
   * DOM id of the canvas node that consumes this function (the activity whose
   * configuration references `{{{function.<id>.output}}}`). Used to highlight
   * the node on hover. Null when not consumed by a canvas node.
   */
  activityId: string | null;
  /**
   * How the function is used:
   *  - "node":     consumed by an activity → has a canvas node (originApp set);
   *  - "function": consumed only by another function (e.g. an aggregate) →
   *                in use but with no own node (`usedBy` names the consumer);
   *  - "unused":   not referenced anywhere ("sem uso").
   */
  usage: FunctionUsage;
  /** Name of the function that consumes this one, when usage==="function". */
  usedBy: string | null;
}

// Req 7 — one summary per CONDITION activity.
export interface ConditionSummary {
  activityId: string;
  label: string; // the condition's human name (e.g. "When-ERP-Customer")
  conditionType: string; // Req 7.3
  clauses: ConditionClause[]; // Req 7.2
  hasClauses: boolean; // false → "no defined clauses" indicator (Req 7.4)
  /** DOM id of the node this condition gates (connections.next[0]); for hover. */
  targetId: string | null;
  /** True when this is the "else"/OTHERWISE branch of the conditions. */
  isElse: boolean;
}

export interface ConditionClause {
  input: string;
  operation: string;
  expected: string; // the value compared against (Req 7.2)
  booleanOperator: string | null; // null for the last clause (Req 7.2)
}

const WEBHOOK = "WEBHOOK";
const CONDITION = "CONDITION";
const OTHERWISE = "OTHERWISE";
const PUBLISHED = "PUBLISHED";

// ---------------------------------------------------------------------------
// Pure resolvers
// ---------------------------------------------------------------------------

/**
 * Resolves the Origin_App for every function in `flow.functions`, returning
 * exactly one entry per function (Req 6.1, 6.2, 6.4). Each function is resolved
 * independently from the related Flow_Activity's origin metadata; when nothing
 * resolves the entry's `originApp` is null, which never affects any other
 * function's resolved origin (Req 6.3).
 */
export function resolveFunctionOrigins(flow: Flow): FunctionOrigin[] {
  const functions = flow?.functions ?? {};
  const activities = flow?.activities ?? {};

  const entries = Object.entries(functions).map(([key, fn]) => {
    const functionId = fn?.id ?? key;
    const functionName = fn?.name ?? "";

    // Category 1: consumed by an ACTIVITY (has a canvas node + origin app).
    const match = findConsumingActivity(activities, functionId);
    if (match) {
      return {
        functionId,
        functionName,
        originApp: resolveOriginApp(match.activity),
        activityId: match.activityId,
        usage: "node" as const,
        usedBy: null,
      };
    }

    // Category 2: consumed only by ANOTHER FUNCTION (e.g. an aggregate that
    // references `{{{function.<id>.output}}}`). In use, but no own canvas node.
    const consumerFn = findConsumingFunction(functions, functionId);
    if (consumerFn) {
      return {
        functionId,
        functionName,
        originApp: null,
        activityId: null,
        usage: "function" as const,
        usedBy: consumerFn,
      };
    }

    // Category 3: not referenced anywhere → unused.
    return {
      functionId,
      functionName,
      originApp: null,
      activityId: null,
      usage: "unused" as const,
      usedBy: null,
    };
  });

  // Sort: in-use first (node, then function), unused last. Stable within group.
  const rank: Record<FunctionUsage, number> = { node: 0, function: 1, unused: 2 };
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank[a.e.usage] - rank[b.e.usage] || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * Finds a function (other than `functionId`) whose configuration references
 * `function.<functionId>.output` — e.g. an aggregate consuming sub-functions.
 * Returns the consumer function's name, or null.
 */
function findConsumingFunction(
  functions: Record<string, FlowFunction>,
  functionId: string,
): string | null {
  const needle = `function.${functionId}.output`;
  for (const [key, fn] of Object.entries(functions)) {
    if ((fn?.id ?? key) === functionId) continue;
    const haystack = JSON.stringify((fn as { params?: unknown })?.params ?? {});
    if (haystack.includes(needle)) {
      return fn?.name ?? key;
    }
  }
  return null;
}

/**
 * Builds a human-readable summary for every CONDITION activity (Req 7.1),
 * carrying `conditionType` (Req 7.3) and one clause per
 * `configurations.conditions[]` entry (Req 7.2). The last clause's
 * `booleanOperator` is null. An empty conditions array yields a summary flagged
 * as having no defined clauses (Req 7.4).
 */
export function summarizeConditions(flow: Flow): ConditionSummary[] {
  const activities = flow?.activities ?? {};
  const summaries: ConditionSummary[] = [];

  for (const [activityId, activity] of Object.entries(activities)) {
    const isElse = activity?.type === OTHERWISE;
    if (activity?.type !== CONDITION && !isElse) {
      continue;
    }

    const config = (activity.configurations ?? {}) as {
      conditions?: unknown;
      conditionType?: string;
    };
    // The real shape is an array of arrays of clauses: conditions[][]. We flatten
    // it to a single ordered clause list. Each clause carries input/operation/
    // expected/booleanOperator. (Tolerate a flat array too, defensively.)
    const raw = config.conditions;
    const flat: Array<Record<string, unknown>> = [];
    if (Array.isArray(raw)) {
      for (const group of raw) {
        if (Array.isArray(group)) {
          for (const c of group) {
            if (c && typeof c === "object") flat.push(c as Record<string, unknown>);
          }
        } else if (group && typeof group === "object") {
          flat.push(group as Record<string, unknown>);
        }
      }
    }

    const clauses: ConditionClause[] = flat.map((clause, index) => ({
      input: typeof clause.input === "string" ? clause.input : "",
      operation: typeof clause.operation === "string" ? clause.operation : "",
      expected:
        clause.expected === undefined || clause.expected === null
          ? ""
          : String(clause.expected),
      // The booleanOperator joins a clause to the NEXT clause, so the last
      // clause has none (Req 7.2).
      booleanOperator:
        index < flat.length - 1
          ? (typeof clause.booleanOperator === "string"
              ? clause.booleanOperator
              : null)
          : null,
    }));

    const label =
      (activity as unknown as { label?: string; name?: string }).label ??
      (activity as unknown as { name?: string }).name ??
      activityId;

    const nextList = (activity as unknown as {
      connections?: { next?: unknown };
    }).connections?.next;
    const targetId =
      Array.isArray(nextList) && typeof nextList[0] === "string"
        ? (nextList[0] as string)
        : null;

    summaries.push({
      activityId,
      label,
      conditionType: isElse ? "else" : config.conditionType ?? "",
      clauses,
      hasClauses: clauses.length > 0,
      targetId,
      isElse,
    });
  }

  return summaries;
}

/**
 * Maps a Step to the canvas node (DOM id) it executed on (Req 15).
 *
 * The Steps_API does NOT carry the canvas node id directly: a step's
 * `componentId` is the application/service UUID (e.g. a Generator's service id),
 * which is shared across every node backed by that service and so cannot
 * identify one node. The reliable key is the step's human `activityLabel`, which
 * equals the flow activity's `label` (verified against the real "gerenciador
 * api" flow: steps "Webhook", "gerenciador api", "get all pets", "get 10",
 * "split 10" line up with activity labels, whose map keys are the DOM ids
 * `webhook-hook-trigger`, `id-generator1`, `id3`, `id-javascript4`,
 * `id-splitter2`).
 *
 * `buildStepNodeIndex` flattens every activity (including splitter sub-flow
 * activities) into lookup tables keyed by label, by key, and by the activity's
 * own `componentId`/`componentResourceId` (which equals the key for triggers
 * like `webhook-hook-trigger`). `resolveStepNodeId` then resolves a step against
 * those tables, preferring the label match. Returns null when nothing resolves,
 * so the highlighter simply skips that step (Req 15.3).
 */
export interface StepNodeIndex {
  /** Normalized activity label -> DOM node id (the activity map key). */
  byLabel: Map<string, string>;
  /** The activity's own componentId/componentResourceId -> DOM node id. */
  byComponentId: Map<string, string>;
  /** The activity key itself, so a step already carrying the key resolves. */
  keys: Set<string>;
}

function normLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function buildStepNodeIndex(flow: Flow | undefined): StepNodeIndex {
  const byLabel = new Map<string, string>();
  const byComponentId = new Map<string, string>();
  const keys = new Set<string>();

  const indexActivities = (activities: Record<string, FlowActivity> | undefined): void => {
    for (const [key, activity] of Object.entries(activities ?? {})) {
      keys.add(key);
      const a = activity as unknown as {
        label?: string;
        name?: string;
        componentId?: string;
        componentResourceId?: string;
        configurations?: { subFlow?: { activities?: Record<string, FlowActivity> } };
      };
      // Label is the primary key; first writer wins so earlier (top-level)
      // activities are not shadowed by a nested duplicate label.
      const label = normLabel(a.label) || normLabel(a.name);
      if (label && !byLabel.has(label)) {
        byLabel.set(label, key);
      }
      for (const cid of [a.componentId, a.componentResourceId]) {
        if (typeof cid === "string" && cid !== "" && !byComponentId.has(cid)) {
          byComponentId.set(cid, key);
        }
      }
      // Recurse into splitter sub-flow activities so split-child steps resolve.
      indexActivities(a.configurations?.subFlow?.activities);
    }
  };

  indexActivities(flow?.activities);
  return { byLabel, byComponentId, keys };
}

export function resolveStepNodeId(
  step: {
    componentId?: string;
    activityLabel?: string;
    inHeaders?: unknown;
    outHeaders?: unknown;
  },
  index: StepNodeIndex,
): string | null {
  // 1) `inHeaders.activityId` is the CANONICAL canvas node key: the real steps
  //    carry it verbatim (e.g. "id-generator1", "id3", "id-javascript4",
  //    "id-generator6") and it is the exact DOM id, so prefer it. (A CONDITION
  //    step omits it, so the label fallback below handles conditions.)
  const headerId =
    readActivityId(step.inHeaders) ?? readActivityId(step.outHeaders);
  if (headerId && index.keys.has(headerId)) {
    return headerId;
  }
  // 2) Label match (works for conditions, whose label equals the activity label).
  const label = normLabel(step.activityLabel);
  if (label && index.byLabel.has(label)) {
    return index.byLabel.get(label) ?? null;
  }
  const cid = typeof step.componentId === "string" ? step.componentId : "";
  // 3) The step's componentId is already a canvas key (e.g. the webhook).
  if (cid && index.keys.has(cid)) {
    return cid;
  }
  // 4) The step's componentId matches an activity's own component id.
  if (cid && index.byComponentId.has(cid)) {
    return index.byComponentId.get(cid) ?? null;
  }
  return null;
}

/** Reads `headers.activityId` when present and a non-empty string. */
function readActivityId(headers: unknown): string | null {
  if (headers && typeof headers === "object") {
    const v = (headers as Record<string, unknown>).activityId;
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  return null;
}

/**
 * Decides whether the execute button should appear (Req 8.1, 8.3, 8.4): true
 * iff `flow.start` resolves to a WEBHOOK start activity (sync or async, Req 8.2)
 * AND `integration.active === true` AND `integration.status === "PUBLISHED"`.
 */
export function shouldShowExecuteButton(integration: Integration): boolean {
  const flow = integration?.flow;
  const startActivity = flow?.activities?.[flow?.start];
  const isWebhookStart = startActivity?.type === WEBHOOK;

  return isWebhookStart && integration?.active === true && integration?.status === PUBLISHED;
}

// ---------------------------------------------------------------------------
// Resolution internals
// ---------------------------------------------------------------------------

/**
 * Finds the activity that CONSUMES a function: the one whose configuration (any
 * nested string) references `{{{function.<functionId>.output}}}` or
 * `{{{<functionId>}}}` / `{{{<functionId>.…}}}`. Returns the activity plus its
 * map key (the canvas node's DOM id). Undefined when no activity references it.
 */
function findConsumingActivity(
  activities: Record<string, FlowActivity>,
  functionId: string,
): { activityId: string; activity: FlowActivity } | undefined {
  const needles = [
    `function.${functionId}.output`,
    `{{{${functionId}}}}`,
    `{{{${functionId}.`,
  ];
  for (const [activityId, activity] of Object.entries(activities)) {
    const haystack = JSON.stringify(
      (activity as { configurations?: unknown })?.configurations ?? {},
    );
    if (needles.some((n) => haystack.includes(n))) {
      return { activityId, activity };
    }
  }
  return undefined;
}

/**
 * Derives a readable Origin_App label from an activity's origin metadata
 * (`ownerTenantName`, `componentAccountId`, `serviceId`, `isCustom`, `shared`).
 * Returns null when no activity resolved or all origin fields are empty
 * (Req 6.3).
 */
function resolveOriginApp(activity: FlowActivity | undefined): string | null {
  if (!activity) {
    return null;
  }

  const a = activity as unknown as {
    name?: string;
    label?: string;
    ownerTenantName?: string;
  };
  // The human-meaningful origin is the app name (e.g. "TOTVS HUB CRM") plus the
  // activity label (e.g. "POST-Hub-OrderStatus"). Fall back progressively.
  const app = firstNonEmpty(a.name, activity.ownerTenantName);
  const label = firstNonEmpty(a.label);
  if (app === null && label === null) {
    return null;
  }
  if (app !== null && label !== null && app !== label) {
    return `${app} — ${label}`;
  }
  return app ?? label;
}

/** Returns the first non-empty, trimmed string among the candidates, else null. */
function firstNonEmpty(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM rendering (kept separate from the pure resolvers)
// ---------------------------------------------------------------------------

/**
 * Renders the resolved Origin_App alongside each function (Req 6.2, 6.4),
 * showing a not-available indicator when the origin is null (Req 6.3).
 */
export function renderFunctionOrigins(
  origins: FunctionOrigin[],
  onHover?: (activityId: string | null) => void,
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "ipaas-helper-function-origins";

  for (const origin of origins) {
    const item = document.createElement("li");
    item.className = "ipaas-helper-function-origin";
    item.dataset.functionId = origin.functionId;
    if (origin.activityId) {
      item.dataset.activityId = origin.activityId;
      item.classList.add("ipaas-helper-hoverable");
    }

    const name = document.createElement("span");
    name.className = "ipaas-helper-function-name";
    name.textContent = origin.functionName || origin.functionId;

    const app = document.createElement("span");
    app.className = "ipaas-helper-function-app";
    if (origin.usage === "node" && origin.originApp) {
      app.textContent = origin.originApp;
    } else if (origin.usage === "function") {
      app.textContent = origin.usedBy
        ? `usada por ${origin.usedBy}`
        : "usada por outra função";
    } else {
      app.classList.add("ipaas-helper-not-available");
      item.classList.add("ipaas-helper-unused");
      app.textContent = "sem uso";
    }

    item.append(name, app);

    // Hover → highlight the consuming node on the canvas (Req 6 helper).
    if (onHover && origin.activityId) {
      item.addEventListener("mouseenter", () => onHover(origin.activityId));
      item.addEventListener("mouseleave", () => onHover(null));
    }

    list.appendChild(item);
  }

  return list;
}

/**
 * Renders a readable summary for each CONDITION activity (Req 7.1-7.4),
 * including the conditionType, each clause, and the "no defined clauses"
 * indicator for empty summaries.
 */
export function renderConditionSummaries(
  summaries: ConditionSummary[],
  onHover?: (targetId: string | null) => void,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "ipaas-helper-condition-summaries";

  for (const summary of summaries) {
    const block = document.createElement("div");
    block.className = "ipaas-helper-condition-summary";
    block.dataset.activityId = summary.activityId;
    if (onHover && summary.targetId) {
      block.classList.add("ipaas-helper-hoverable");
      block.addEventListener("mouseenter", () => onHover(summary.targetId));
      block.addEventListener("mouseleave", () => onHover(null));
    }

    if (summary.isElse) {
      block.classList.add("ipaas-helper-condition-else");
    }

    // Human name of the condition (e.g. "When-ERP-Customer") + its type.
    const type = document.createElement("div");
    type.className = "ipaas-helper-condition-type";
    type.textContent = summary.isElse
      ? `${summary.label} · senão (else)`
      : summary.label
        ? `${summary.label} (${summary.conditionType})`
        : summary.conditionType;
    block.appendChild(type);

    if (summary.isElse) {
      const note = document.createElement("div");
      note.className = "ipaas-helper-condition-empty";
      note.textContent = "Executado quando nenhuma condição acima é satisfeita.";
      block.appendChild(note);
    } else if (!summary.hasClauses) {
      const empty = document.createElement("div");
      empty.className = "ipaas-helper-condition-empty";
      empty.textContent = "Sem cláusulas definidas";
      block.appendChild(empty);
    } else {
      const clauseList = document.createElement("ul");
      clauseList.className = "ipaas-helper-condition-clauses";
      for (const clause of summary.clauses) {
        const item = document.createElement("li");
        item.className = "ipaas-helper-condition-clause";
        const operator = clause.booleanOperator ? ` ${clause.booleanOperator}` : "";
        const expected = clause.expected ? ` ${clause.expected}` : "";
        // e.g. "{{...Transaction}} EQUALS CUSTOMER &&"
        item.textContent = `${clause.input} ${clause.operation}${expected}${operator}`.trim();
        clauseList.appendChild(item);
      }
      block.appendChild(clauseList);
    }

    container.appendChild(block);
  }

  return container;
}
