import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ApiClient } from "../../src/api/api-client";

// Feature: ipaas-helper-extension, Property 20: Bearer header injection
// Validates: Requirements 16.1
//
// For any ApiClient call made while the Session_Cookie is present and
// non-empty, the outgoing request includes the header
// `Authorization: Bearer {cookie_value}` built from the cookie value.

/** A representative call across GET and POST endpoints. */
type EndpointCall = (client: ApiClient) => Promise<unknown>;

const endpointCalls: ReadonlyArray<{ name: string; call: EndpointCall }> = [
  { name: "getRole (GET)", call: (c) => c.getRole("user-1", "tenant-1") },
  { name: "getIntegration (GET)", call: (c) => c.getIntegration("diagram-1") },
  { name: "getMessage (GET)", call: (c) => c.getMessage("msg-1") },
  {
    name: "getSteps (GET)",
    call: (c) => c.getSteps("int-1", "2024-01-01", "msg-1"),
  },
  {
    name: "getChildMessages (GET)",
    call: (c) =>
      c.getChildMessages("origin-1"),
  },
  { name: "getKeys (POST)", call: (c) => c.getKeys() },
  // NOTE: `execute` is intentionally excluded — the webhook authenticates via
  // the apiKey in the URL, so the ApiClient omits the Bearer header on executions
  // to avoid leaking the session JWT into the triggered message (see Req 16.1).
];

// Arbitrary non-empty token strings (the Session_Cookie value).
const nonEmptyToken = fc.string({ minLength: 1 });

describe("Property 20: Bearer header injection", () => {
  it("injects `Authorization: Bearer {token}` on every GET/POST endpoint when the session cookie is present", async () => {
    await fc.assert(
      fc.asyncProperty(nonEmptyToken, async (token) => {
        for (const { name, call } of endpointCalls) {
          // Capture the raw headers the ApiClient attaches to the request. The
          // client builds a plain `Record<string, string>`; we assert against
          // it directly rather than through a WHATWG `Headers` instance, which
          // would trim HTTP whitespace from the value and hide what was sent.
          let captured: Record<string, string> | undefined;

          const client = new ApiClient({
            readToken: async () => token,
            fetchFn: async (_input, init) => {
              captured = init.headers as Record<string, string>;
              return new Response(JSON.stringify({ items: [] }), {
                status: 200,
              });
            },
          });

          await call(client);

          // An outbound request must have been made and carried the header.
          expect(captured, `no request captured for ${name}`).toBeDefined();
          expect(captured!["Authorization"], `wrong header for ${name}`).toBe(
            `Bearer ${token}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});
