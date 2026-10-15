import { describe, it, expect } from "vitest";
import { ApiClient } from "../../src/api/api-client";
import type { Integration } from "../../src/models";

// Unit tests for per-endpoint request construction (Task 4.7).
// Asserts the exact URL, query params, HTTP method, and body each ApiClient
// endpoint wrapper emits, plus the Bearer header and the Integrations_API
// first-item selection.
// Requirements: 4.2, 5.2, 5.3, 9.1, 11.1, 13.1

const HOST = "https://api-ipaas.totvs.app";
const TOKEN = "test-token-123";

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Build an ApiClient wired to a non-empty token and a fetch stub that captures
 * the outbound request and returns a 200 JSON Response with the given payload.
 */
function makeClient(payload: unknown): {
  client: ApiClient;
  captured: () => CapturedRequest | undefined;
} {
  let captured: CapturedRequest | undefined;
  const client = new ApiClient({
    readToken: async () => TOKEN,
    fetchFn: async (input, init) => {
      captured = {
        url: input,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body:
          typeof init.body === "string"
            ? JSON.parse(init.body)
            : init.body,
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  return { client, captured: () => captured };
}

describe("ApiClient per-endpoint request construction", () => {
  it("Roles_API: GET by-user-tenant with userCode/tenantCode query + Bearer header", async () => {
    const { client, captured } = makeClient({
      name: "Admin",
      type: "ROLE",
      gatewayEnabled: true,
      features: [],
    });

    await client.getRole("user-42", "tenant-7");

    const req = captured()!;
    expect(req.url).toBe(
      `${HOST}/connector-auth/api/v1/roles/by-user-tenant` +
        `?userCode=user-42&tenantCode=tenant-7`,
    );
    expect(req.method).toBe("GET");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toBeUndefined();
  });

  it("Integrations_API: GET with diagramId/fieldsReturn/pageSize=1 and returns the first item", async () => {
    const first: Integration = {
      id: "int-first",
      name: "First Integration",
      active: true,
      status: "PUBLISHED",
      flow: {
        async: false,
        functions: {},
        activities: {},
        start: "start",
      },
    };
    const second: Integration = {
      ...first,
      id: "int-second",
      name: "Second Integration",
    };
    const { client, captured } = makeClient([first, second]);

    const result = await client.getIntegration("diagram-abc");

    const req = captured()!;
    expect(req.url).toBe(
      `${HOST}/ipaas/api/v3/integrations` +
        `?diagramId=diagram-abc` +
        `&fieldsReturn=${encodeURIComponent("id,name,active,status,flow")}` +
        `&pageSize=1`,
    );
    expect(req.method).toBe("GET");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toBeUndefined();

    // First-item selection (Req 5.3): the returned data is the first list entry.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(first);
    }
  });

  it("Keys_API: POST keys?page=0&pageSize=9999 with body {}", async () => {
    const { client, captured } = makeClient({ items: [] });

    await client.getKeys();

    const req = captured()!;
    expect(req.url).toBe(`${HOST}/ipaas/api/v4/keys?page=0&pageSize=9999`);
    expect(req.method).toBe("POST");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.body).toEqual({});
  });

  it("Execute_API: POST integrations/{id}/api-key/{apiKey} passing body + headers through", async () => {
    const { client, captured } = makeClient({
      status: "OK",
      messageId: "msg-xyz",
      timestamp: "2024-01-01T00:00:00Z",
    });

    const body = { foo: "bar", nested: { n: 1 } };
    const headers = { "X-Custom": "custom-value" };

    await client.execute("int-9", "api-key-9", body, headers);

    const req = captured()!;
    expect(req.url).toBe(
      `${HOST}/ipaas/api/v1/integrations/int-9/api-key/api-key-9`,
    );
    expect(req.method).toBe("POST");
    // The webhook authenticates via the apiKey in the URL; the session JWT must
    // NOT be forwarded (it would leak into the executed message's headers).
    expect(req.headers["Authorization"]).toBeUndefined();
    expect(req.headers["Content-Type"]).toBe("application/json");
    // User-supplied headers are still passed through.
    expect(req.headers["X-Custom"]).toBe("custom-value");
    // User-supplied body is forwarded as the request body.
    expect(req.body).toEqual(body);
  });

  it("Steps_API: GET steps/{integrationId}/{createdDate}/{messageId}", async () => {
    const { client, captured } = makeClient([]);

    await client.getSteps("int-5", "2024-02-03", "msg-77");

    const req = captured()!;
    expect(req.url).toBe(
      `${HOST}/ipaas/api/v3/steps/int-5/2024-02-03/msg-77`,
    );
    expect(req.method).toBe("GET");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toBeUndefined();
  });

  it("Child_Messages_API: GET messages?sourceTypes=SPLITTED&originMessageId=... with the status filter (no date window)", async () => {
    const { client, captured } = makeClient({
      items: [],
      total: 0,
    });

    await client.getChildMessages("origin-55");

    const req = captured()!;
    // No initialDate/finalDate (the live API rejects ISO datetimes with 400);
    // capped at pageSize=50.
    expect(req.url).toBe(
      `${HOST}/ipaas/api/v4/messages` +
        `?sourceTypes=SPLITTED` +
        `&originMessageId=origin-55` +
        `&page=0&pageSize=50` +
        `&status=DONE&status=ERROR&status=REPROCESSED&status=PROCESSING`,
    );
    expect(req.method).toBe("GET");
    expect(req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toBeUndefined();
  });
});
