import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ApiClient } from "../../src/api/api-client";

// Feature: ipaas-helper-extension, Property 24: Error-outcome classification
// Validates: Requirements 18.1, 18.2, 18.3
//
// For any fetch outcome, the ApiClient maps it to the correct ApiResult kind:
//   - a non-200/non-401 status            -> { ok:false, kind:"http_error", status }
//   - a fetch rejection (non-abort)       -> { ok:false, kind:"network" }
//   - an AbortController abort/timeout     -> { ok:false, kind:"timeout" }
//
// Each case drives the ApiClient through its injectable { fetchFn, readToken }
// deps. `readToken` is stubbed to a non-empty token so the no-session guard
// (Req 16.3) never short-circuits and the fetch path is always exercised. A
// representative endpoint wrapper (`getRole`) is used to reach the shared
// classification core; the outcome kind is independent of the endpoint.

const NON_EMPTY_TOKEN = "header.payload.signature";
const readToken = async () => NON_EMPTY_TOKEN;

/** Builds a Response-like stub carrying a status; `json()` is unused on error paths. */
function statusResponse(status: number): Response {
  return {
    status,
    json: async () => ({}),
  } as unknown as Response;
}

/** An Error whose name marks it as an AbortController abort (timeout, Req 18.2). */
function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("Property 24: Error-outcome classification", () => {
  it("maps a non-200/non-401 status to { ok:false, kind:'http_error', status } (Req 18.3)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }).filter((s) => s !== 401),
        async (status) => {
          const client = new ApiClient({
            readToken,
            fetchFn: async () => statusResponse(status),
          });

          const result = await client.getRole("user-code", "tenant-code");

          expect(result).toEqual({ ok: false, kind: "http_error", status });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("maps a non-abort fetch rejection to { ok:false, kind:'network' } (Req 18.1)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (message) => {
        const client = new ApiClient({
          readToken,
          fetchFn: async () => {
            throw new Error(message);
          },
        });

        const result = await client.getRole("user-code", "tenant-code");

        expect(result).toEqual({ ok: false, kind: "network" });
      }),
      { numRuns: 100 },
    );
  });

  it("maps an AbortError rejection to { ok:false, kind:'timeout' } (Req 18.2)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (_seed) => {
        const client = new ApiClient({
          readToken,
          fetchFn: async () => {
            throw abortError();
          },
        });

        const result = await client.getRole("user-code", "tenant-code");

        expect(result).toEqual({ ok: false, kind: "timeout" });
      }),
      { numRuns: 100 },
    );
  });
});
