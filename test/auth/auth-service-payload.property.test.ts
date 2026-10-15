// Feature: ipaas-helper-extension, Property 3: Undecodable payload detection
//
// Property statement: For any three-segment token whose middle segment does not
// Base64URL-decode into a syntactically valid JSON object, the JWT_Decoder
// returns `payload_not_json`.
//
// Validates: Requirements 2.5
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decodeJwt } from "../../src/auth/auth-service";

/** Base64URL-encode raw bytes the same way JWT payloads are encoded. */
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64URL-encode a UTF-8 string. */
function base64UrlEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return base64UrlEncodeBytes(bytes);
}

/**
 * Mirror of the decoder's Base64URL -> UTF-8 step, used only inside the test to
 * confirm that each generated segment genuinely fails the "valid JSON object"
 * check before we assert on decodeJwt. This keeps the generator honest: we only
 * assert `payload_not_json` for inputs that truly are not a JSON object.
 */
function decodedIsJsonObject(segment: string): boolean {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

// Generator for payload segments that must NOT decode to a JSON object.
const nonObjectPayloadSegment = fc.oneof(
  // (a) Random bytes: Base64URL-encoded garbage that almost never parses as JSON.
  fc.uint8Array({ minLength: 1, maxLength: 48 }).map(base64UrlEncodeBytes),
  // (b) JSON arrays — valid JSON but not an object.
  fc
    .array(fc.jsonValue(), { maxLength: 5 })
    .map((arr) => base64UrlEncodeText(JSON.stringify(arr))),
  // (c) JSON primitives — number, string, boolean, null.
  fc
    .oneof(
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    )
    .map((prim) => base64UrlEncodeText(JSON.stringify(prim))),
  // (d) Syntactically invalid JSON text.
  fc
    .oneof(
      fc.constant("{not json"),
      fc.constant("}{"),
      fc.constant("undefined"),
      fc.constant("'single quoted'"),
      fc.constant("{\"a\":}"),
      fc.constant("[1, 2,"),
      fc.constant("NaN"),
      fc.string().filter((s) => {
        try {
          JSON.parse(s);
          return false;
        } catch {
          return true;
        }
      }),
    )
    .map(base64UrlEncodeText),
);

// Header and signature segments can be any non-empty strings without dots.
const nonDotSegment = fc
  .string({ minLength: 1 })
  .filter((s) => !s.includes("."));

describe("Feature: ipaas-helper-extension, Property 3: Undecodable payload detection", () => {
  it("returns payload_not_json for any three-segment token whose middle segment is not a JSON object", () => {
    fc.assert(
      fc.property(
        nonDotSegment,
        nonObjectPayloadSegment,
        nonDotSegment,
        (header, payload, signature) => {
          // Guard: only assert on payloads that genuinely are not a JSON object.
          fc.pre(!decodedIsJsonObject(payload));

          const token = `${header}.${payload}.${signature}`;
          const result = decodeJwt(token);

          expect(result).toEqual({ ok: false, reason: "payload_not_json" });
        },
      ),
      { numRuns: 100 },
    );
  });
});
