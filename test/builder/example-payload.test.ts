import { describe, it, expect } from "vitest";
import { buildExamplePayload } from "../../src/builder/example-payload";
import type { Flow } from "../../src/models";

// Feature: ipaas-helper-extension — Example payload from flow trigger tags
//
// Reconstructs an example request body/headers from `{{{<trigger>.inBody.*}}}`
// and `{{{<trigger>.inHeader.*}}}` references found in the flow configurations.

function flowWith(start: string, configs: Record<string, unknown>): Flow {
  return {
    async: false,
    functions: {},
    activities: {
      [start]: { type: "WEBHOOK" } as never,
      node: { type: "GENERATOR", configurations: configs } as never,
    },
    start,
  } as Flow;
}

describe("buildExamplePayload", () => {
  it("reconstructs a nested body from deep inBody paths", () => {
    const flow = flowWith("webhook-hook-trigger", {
      a: "{{{webhook-hook-trigger.inBody.pedido.id}}}",
      b: "x {{{webhook-hook-trigger.inBody.pedido.cliente.nome}}} y",
      c: "{{{webhook-hook-trigger.inBody.itens[0].sku}}}",
    });
    const { body } = buildExamplePayload(flow);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      pedido: {
        id: "<pedido.id>",
        cliente: { nome: "<pedido.cliente.nome>" },
      },
      itens: [{ sku: "<itens[0].sku>" }],
    });
  });

  it("adds header lines for inHeader paths plus a default Content-Type", () => {
    const flow = flowWith("webhook-sync-trigger", {
      h: "{{{webhook-sync-trigger.inHeader.x-tenant}}}",
    });
    const { headers } = buildExamplePayload(flow);
    const lines = headers.split("\n");
    expect(lines).toContain("Content-Type: application/json");
    expect(lines).toContain("x-tenant: <x-tenant>");
  });

  it("falls back to a generic body + header when only the whole trigger is referenced", () => {
    const flow = flowWith("webhook-hook-trigger", {
      fileContent: "{{{webhook-hook-trigger}}}",
    });
    const { body, headers } = buildExamplePayload(flow);
    const parsed = JSON.parse(body);
    // Generic example object (non-empty), not derived from any path.
    expect(typeof parsed).toBe("object");
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(headers).toContain("Content-Type: application/json");
  });

  it("falls back to generic when there are no trigger references at all", () => {
    const flow = flowWith("webhook-hook-trigger", { name: "no tags here" });
    const { body } = buildExamplePayload(flow);
    expect(JSON.parse(body)).toEqual({
      id: 1,
      nome: "exemplo",
      ativo: true,
      dados: { chave: "valor" },
    });
  });

  it("treats a direct trigger tag (no inBody prefix) as a body field", () => {
    const flow = flowWith("webhook-hook-trigger", {
      a: "{{{webhook-hook-trigger.teste}}}",
      b: "{{{webhook-hook-trigger.pedido.id}}}",
    });
    const { body } = buildExamplePayload(flow);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      teste: "<teste>",
      pedido: { id: "<pedido.id>" },
    });
  });

  it("whole-facet inBody reference (no sub-path) contributes no structure", () => {
    const flow = flowWith("webhook-hook-trigger", {
      a: "{{{webhook-hook-trigger.inBody}}}",
    });
    const { body } = buildExamplePayload(flow);
    // No sub-paths -> generic fallback.
    expect(Object.keys(JSON.parse(body)).length).toBeGreaterThan(0);
  });
});
