// Builds an example request body + headers for the Execution_Modal by scanning
// the flow for references to the webhook trigger's inBody/inHeader tags, e.g.
// `{{{webhook-hook-trigger.inBody.pedido.id}}}`. The reconstructed structure
// mirrors exactly the paths the flow consumes, so the example is tailored to
// each integration. When the flow only references the whole body (no sub-paths),
// a minimal generic example is used.
//
// Pure and dependency-free so it is unit-testable.

import type { Flow } from "../models";

export interface ExamplePayload {
  body: string; // pretty-printed JSON
  headers: string; // "Name: value" lines
}

/** A single parsed path segment: an object key or an array index. */
type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

/**
 * Parses a dotted path with optional array indices into segments.
 * e.g. "pedido.itens[0].sku" -> [key pedido, key itens, index 0, key sku]
 */
function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  for (const raw of path.split(".")) {
    if (raw === "") continue;
    // Split a segment like `itens[0][1]` into `itens` + indices.
    const name = raw.replace(/\[\d+\]/g, "");
    if (name) segments.push({ kind: "key", key: name });
    const indices = raw.match(/\[(\d+)\]/g) ?? [];
    for (const idx of indices) {
      segments.push({ kind: "index", index: Number(idx.slice(1, -1)) });
    }
  }
  return segments;
}

/** Sets a leaf placeholder at `segments` within `root`, creating containers. */
function setPath(root: Record<string, unknown>, segments: Segment[], leaf: string): void {
  if (segments.length === 0) return;
  // The first segment is always an object key (tags start with a field name).
  let current: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const next = segments[i + 1];

    if (seg.kind === "key") {
      const obj = current as Record<string, unknown>;
      if (isLast) {
        if (obj[seg.key] === undefined) obj[seg.key] = leaf;
      } else {
        const wantArray = next.kind === "index";
        if (obj[seg.key] === undefined) obj[seg.key] = wantArray ? [] : {};
        current = obj[seg.key];
      }
    } else {
      const arr = current as unknown[];
      if (isLast) {
        if (arr[seg.index] === undefined) arr[seg.index] = leaf;
      } else {
        const wantArray = next.kind === "index";
        if (arr[seg.index] === undefined) arr[seg.index] = wantArray ? [] : {};
        current = arr[seg.index];
      }
    }
  }
}

/** Recursively collects every string found in an arbitrary value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
}

/**
 * Extracts the sub-paths referenced for a given facet (`inBody` or `inHeader`)
 * of the trigger across all collected strings. Returns the unique dotted paths
 * (without the facet prefix); an empty-path reference (the whole body) yields
 * `[""]` so callers can distinguish "referenced wholesale" from "not referenced".
 */
interface TriggerPaths {
  body: string[];
  header: string[];
}

/**
 * Extracts, from all collected strings, the paths referenced off the trigger.
 * A tag looks like `{{{<triggerId>(.<path>)?}}}`. Classification of `<path>`:
 *  - starts with `inHeader` -> a header path (prefix stripped);
 *  - starts with `inBody`   -> a body path (prefix stripped);
 *  - anything else (direct, e.g. `teste`) -> a body path as-is;
 *  - empty (whole trigger)  -> contributes no structure.
 * Returns unique dotted body/header paths (without the facet prefix).
 */
function extractPaths(strings: string[], triggerId: string): TriggerPaths {
  const escaped = triggerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Capture everything after the triggerId up to the closing braces.
  const re = new RegExp(`\\{\\{\\{${escaped}((?:\\.[^}\\s]+)?)\\}\\}\\}`, "g");
  const body = new Set<string>();
  const header = new Set<string>();
  for (const str of strings) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(str)) !== null) {
      const raw = m[1].startsWith(".") ? m[1].slice(1) : m[1]; // e.g. "inBody.pedido.id", "teste", ""
      if (raw === "") continue; // whole-trigger reference: no structure
      if (raw === "inHeader" || raw.startsWith("inHeader.")) {
        const path = raw === "inHeader" ? "" : raw.slice("inHeader.".length);
        if (path) header.add(path);
      } else if (raw === "inBody" || raw.startsWith("inBody.")) {
        const path = raw === "inBody" ? "" : raw.slice("inBody.".length);
        if (path) body.add(path);
      } else {
        // Direct reference (no inBody/inHeader prefix) -> body field.
        body.add(raw);
      }
    }
  }
  return { body: [...body], header: [...header] };
}

/** Builds a nested example object from a set of dotted paths. */
function buildFromPaths(paths: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    if (path === "") continue; // whole-facet reference contributes no structure
    const segments = parsePath(path);
    setPath(root, segments, `<${path}>`);
  }
  return root;
}

/**
 * Builds the example body + headers for a flow. The trigger id is `flow.start`.
 * Scans every activity's `configurations` for inBody/inHeader tag references and
 * reconstructs the structure; falls back to a minimal generic body when the flow
 * references no sub-paths.
 */
export function buildExamplePayload(flow: Flow): ExamplePayload {
  const triggerId = flow?.start ?? "";
  const strings: string[] = [];
  const activities = flow?.activities ?? {};
  for (const activity of Object.values(activities)) {
    collectStrings((activity as { configurations?: unknown })?.configurations, strings);
  }
  // Also allow references anywhere else in the flow (functions params, etc.).
  collectStrings(flow?.functions ?? {}, strings);

  const { body: bodyPaths, header: headerPaths } = triggerId
    ? extractPaths(strings, triggerId)
    : { body: [], header: [] };

  const bodyObj = buildFromPaths(bodyPaths);
  // Generic fallback when the flow references no inBody sub-paths.
  const GENERIC_BODY = {
    id: 1,
    nome: "exemplo",
    ativo: true,
    dados: { chave: "valor" },
  };
  const body =
    Object.keys(bodyObj).length > 0
      ? JSON.stringify(bodyObj, null, 2)
      : JSON.stringify(GENERIC_BODY, null, 2);

  // Headers: one `Name: <path>` line per referenced header path; always include
  // Content-Type as a sensible default.
  const headerLines = ["Content-Type: application/json"];
  for (const path of headerPaths) {
    if (path === "") continue;
    headerLines.push(`${path}: <${path}>`);
  }
  const headers = headerLines.join("\n");

  return { body, headers };
}
