// Feature: ipaas-helper-extension, Property 23: Allowed-host restriction
//
// Property statement: Every outgoing request URL from the ApiClient targets only
// an allowed iPaaS API host (api-ipaas.totvs.app or api-fluig.totvs.app) — never
// any other host — and always over https.
//
// Validates: Requirements 17.2, 17.3
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ApiClient } from "../../src/api/api-client";
import type { DateWindow } from "../../src/models";

// The only hosts the ApiClient is permitted to contact (Req 17.2, 17.3).
const ALLOWED_HOSTS = new Set(["api-ipaas.totvs.app", "api-fluig.totvs.app"]);

/**
 * Builds an ApiClient whose outbound requests are captured instead of sent.
 * `readToken` returns a non-empty token so no call short-circuits as
 * `no_session` (which would issue no request and defeat the property).
 * `fetchFn` records each URL and returns a fake 200 Response with a JSON body
 * generic enough for every endpoint's response shaping.
 */
function makeCapturingClient(): { client: ApiClient; urls: string[] } {
  const urls: string[] = [];
  const client = new ApiClient({
    readToken: async () => "non-empty-token",
    fetchFn: async (input) => {
      urls.push(input);
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, urls };
}

/** Asserts a captured URL uses https and an allowed host. */
function assertAllowed(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  expect(parsed.protocol).toBe("https:");
  expect(ALLOWED_HOSTS.has(parsed.hostname)).toBe(true);
}

// Arbitrary non-empty string argument (path/query values the methods interpolate).
const arg = fc.string({ minLength: 1 });

const dateWindow: fc.Arbitrary<DateWindow> = fc.record({
  initialDate: fc.string({ minLength: 1 }),
  finalDate: fc.string({ minLength: 1 }),
});

// A JSON-safe value for the execute body, plus arbitrary request headers.
const execBody = fc.jsonValue();
const execHeaders = fc.dictionary(fc.string({ minLength: 1 }), fc.string());

describe("Feature: ipaas-helper-extension, Property 23: Allowed-host restriction", () => {
  it("targets only allowed https iPaaS API hosts across every endpoint method", async () => {
    await fc.assert(
      fc.asyncProperty(
        arg, // userCode
        arg, // tenantCode
        arg, // diagramId
        arg, // integrationId (execute)
        arg, // apiKey (execute)
        execBody,
        execHeaders,
        arg, // messageId (getMessage)
        arg, // integrationId (getSteps)
        arg, // createdDate (getSteps)
        arg, // messageId (getSteps)
        arg, // originMessageId (getChildMessages)
        dateWindow,
        async (
          userCode,
          tenantCode,
          diagramId,
          execIntegrationId,
          apiKey,
          body,
          headers,
          messageId,
          stepsIntegrationId,
          createdDate,
          stepsMessageId,
          originMessageId,
          window,
        ) => {
          const { client, urls } = makeCapturingClient();

          // Exercise every endpoint wrapper with the generated arguments.
          await client.getRole(userCode, tenantCode);
          await client.getIntegration(diagramId);
          await client.getKeys();
          await client.execute(execIntegrationId, apiKey, body, headers);
          await client.getMessage(messageId);
          await client.getSteps(stepsIntegrationId, createdDate, stepsMessageId);
          await client.getChildMessages(originMessageId);

          // One captured URL per method call; all must be allowed https hosts.
          expect(urls.length).toBe(7);
          for (const url of urls) {
            assertAllowed(url);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
