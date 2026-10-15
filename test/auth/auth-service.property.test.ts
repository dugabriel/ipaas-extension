import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decodeJwt } from "../../src/auth/auth-service";

// Feature: ipaas-helper-extension, Property 1: JWT payload decode round-trip
// Validates: Requirements 2.3
//
// For any JSON object used as a JWT payload, encoding it as the middle
// Base64URL segment of a three-segment token (with arbitrary header and
// signature segments) and decoding it with decodeJwt yields claims equal to
// the original object, independent of the signature segment.

/**
 * Base64URL-encodes a UTF-8 string the way the decoder expects: UTF-8 bytes →
 * binary string → btoa → URL-safe alphabet with padding stripped. This mirrors
 * `decodeBase64Url` in auth-service.ts (which reverses these steps).
 */
function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A JSON object: string keys mapped to arbitrary JSON-safe values.
const jsonObject = fc.dictionary(fc.string(), fc.jsonValue());

// Header/signature segments: any non-empty Base64URL string (no "." so the
// three-segment split stays intact). Their contents are never inspected.
const segment = fc
  .string({ minLength: 1 })
  .map((s) => base64UrlEncode(s));

describe("Property 1: JWT payload decode round-trip", () => {
  it("decodes an encoded JSON payload back to an equal object, independent of the signature", () => {
    fc.assert(
      fc.property(jsonObject, segment, segment, (payload, header, signature) => {
        const token = `${header}.${base64UrlEncode(JSON.stringify(payload))}.${signature}`;

        const result = decodeJwt(token);

        // The token carries JSON.stringify(payload), so a correct decoder can
        // only ever reproduce the JSON-normalized payload. Compare against that
        // canonical form: JSON genuinely cannot round-trip values like -0
        // (JSON.stringify(-0) === "0") or `undefined`, so asserting against the
        // raw generated object would be testing the serializer, not the decoder.
        const canonical = JSON.parse(JSON.stringify(payload));

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.claims).toEqual(canonical);
        }
      }),
      { numRuns: 100 },
    );
  });
});
