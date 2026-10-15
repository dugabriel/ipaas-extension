import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ApiClient } from "../../src/api/api-client";
import type { ApiResult } from "../../src/messaging/protocol";

// Feature: ipaas-helper-extension, Property 21: Unauthorized classification
// Validates: Requirements 16.2
//
// For any ApiClient call whose fetch resolves with HTTP 401, the result is
// exactly `{ ok: false, kind: "unauthorized" }` — regardless of the response
// body/headers or which endpoint method was invoked. The Bearer header is
// resolved per call (readToken stubbed to a non-empty token), so no call
// short-circuits to `no_session`.

/** The endpoint methods under test, each invoked with placeholder arguments. */
const endpointInvocations: ReadonlyArray<
  (client: ApiClient) => Promise<ApiResult<unknown>>
> = [
  (c) => c.getRole("user-1", "tenant-1"),
  (c) => c.getIntegration("diagram-1"),
  (c) => c.getKeys(),
  (c) => c.execute("integration-1", "api-key-1", { any: "body" }, {}),
  (c) => c.getMessage("message-1"),
  (c) => c.getSteps("integration-1", "2024-01-01", "message-1"),
  (c) =>
    c.getChildMessages("origin-1"),
];

// Arbitrary response body: any JSON-safe value serialized as the 401 body.
const responseBody = fc.jsonValue().map((v) => JSON.stringify(v));

// Arbitrary response headers: a record of header name/value pairs. Header names
// are constrained to token-valid characters so `new Response` accepts them.
const responseHeaders = fc.dictionary(
  fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]*$/),
  fc.string(),
);

// Which endpoint method to exercise.
const endpointIndex = fc.integer({ min: 0, max: endpointInvocations.length - 1 });

describe("Property 21: Unauthorized classification", () => {
  it("maps any 401 response to { ok: false, kind: 'unauthorized' } for every endpoint", async () => {
    await fc.assert(
      fc.asyncProperty(
        responseBody,
        responseHeaders,
        endpointIndex,
        async (body, headers, index) => {
          const client = new ApiClient({
            // Non-empty token so the request is never short-circuited.
            readToken: async () => "non-empty-token",
            // Every outbound request resolves with HTTP 401.
            fetchFn: async () => new Response(body, { status: 401, headers }),
          });

          const result = await endpointInvocations[index](client);

          expect(result).toEqual({ ok: false, kind: "unauthorized" });
        },
      ),
      { numRuns: 100 },
    );
  });
});
