import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ApiClient } from "../../src/api/api-client";

// Feature: ipaas-helper-extension, Property 22: No-session guard
// Validates: Requirements 16.3
//
// For any ApiClient call made while the Session_Cookie is absent (null) or
// empty (""), the result is `{ ok: false, kind: "no_session" }` AND no outbound
// fetch is made. The readToken dep is stubbed to the absent/empty value and the
// fetchFn spy records every invocation so we can assert it was never called.

/** An absent or empty session token value (Req 16.3). */
const emptyToken = fc.constantFrom<string | null>(null, "");

/** Non-empty string arbitrary used for the endpoint method arguments. */
const str = fc.string();

/**
 * One invocation of each ApiClient endpoint method, parameterized by arbitrary
 * arguments. Each entry runs the method against the given client and returns the
 * ApiResult so the property can assert on it uniformly.
 */
const invocation = fc.oneof(
  fc.record({ userCode: str, tenantCode: str }).map((a) => ({
    name: "getRole",
    run: (c: ApiClient) => c.getRole(a.userCode, a.tenantCode),
  })),
  fc.record({ diagramId: str }).map((a) => ({
    name: "getIntegration",
    run: (c: ApiClient) => c.getIntegration(a.diagramId),
  })),
  fc.constant({
    name: "getKeys",
    run: (c: ApiClient) => c.getKeys(),
  }),
  fc
    .record({
      integrationId: str,
      apiKey: str,
      body: fc.jsonValue(),
      headers: fc.dictionary(str, str),
    })
    .map((a) => ({
      name: "execute",
      run: (c: ApiClient) => c.execute(a.integrationId, a.apiKey, a.body, a.headers),
    })),
  fc.record({ messageId: str }).map((a) => ({
    name: "getMessage",
    run: (c: ApiClient) => c.getMessage(a.messageId),
  })),
  fc
    .record({ integrationId: str, createdDate: str, messageId: str })
    .map((a) => ({
      name: "getSteps",
      run: (c: ApiClient) => c.getSteps(a.integrationId, a.createdDate, a.messageId),
    })),
  fc
    .record({
      originMessageId: str,
      initialDate: str,
      finalDate: str,
    })
    .map((a) => ({
      name: "getChildMessages",
      run: (c: ApiClient) =>
        c.getChildMessages(a.originMessageId),
    })),
);

describe("Property 22: No-session guard", () => {
  it("short-circuits to no_session with no outbound fetch when the cookie is absent/empty", async () => {
    await fc.assert(
      fc.asyncProperty(emptyToken, invocation, async (token, call) => {
        const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
        const fetchFn = (url: string, init: RequestInit) => {
          fetchCalls.push({ url, init });
          return Promise.reject(
            new Error("fetchFn must not be called when the session is absent"),
          );
        };
        const client = new ApiClient({
          fetchFn,
          readToken: () => Promise.resolve(token),
        });

        const result = await call.run(client);

        expect(result).toEqual({ ok: false, kind: "no_session" });
        expect(fetchCalls).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
