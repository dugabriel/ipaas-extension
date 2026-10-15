import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decodeJwt } from "../../src/auth/auth-service";

// Feature: ipaas-helper-extension, Property 2: Malformed token structure detection
// Validates: Requirements 2.4
//
// Property statement: For any string, the JWT_Decoder returns
// `malformed_structure` if and only if the string does not consist of exactly
// three Base64URL segments separated by exactly two dots.
//
// Operationally, "exactly three segments" means `token.split(".")` yields an
// array of length 3. The biconditional has two directions:
//   - When the string does NOT have exactly 3 dot-separated segments, the
//     result MUST be { ok: false, reason: "malformed_structure" }.
//   - When the string DOES have exactly 3 dot-separated segments, the result
//     MUST NOT be malformed_structure (it is either ok, or the structure was
//     valid but the payload was undecodable → payload_not_json).

const isMalformed = (r: ReturnType<typeof decodeJwt>) =>
  r.ok === false && r.reason === "malformed_structure";

describe("Property 2: Malformed token structure detection (Req 2.4)", () => {
  it("returns malformed_structure iff the string lacks exactly three dot-separated segments", () => {
    // A generator that deliberately produces strings with a varying number of
    // dot-separated segments (0/1 handled by segment-free arbitraries; 2, 3,
    // 4+ handled by joining a chosen count of segments with "."). Segments
    // themselves are arbitrary strings WITHOUT dots so the join count is the
    // authoritative segment count.
    const segment = fc.string({ unit: "grapheme" }).map((s) => s.replace(/\./g, ""));

    const multiSegment = fc
      .array(segment, { minLength: 0, maxLength: 6 })
      .map((parts) => parts.join("."));

    // Also mix in fully arbitrary strings (which may contain any number of
    // dots, including zero) to exercise the general input space.
    const anyString = fc.string({ unit: "grapheme" });

    fc.assert(
      fc.property(fc.oneof(multiSegment, anyString), (token) => {
        const segmentCount = token.split(".").length;
        const result = decodeJwt(token);

        if (segmentCount === 3) {
          // Direction 1: exactly 3 segments → never malformed_structure.
          expect(isMalformed(result)).toBe(false);
        } else {
          // Direction 2: not exactly 3 segments → always malformed_structure.
          expect(result).toEqual({ ok: false, reason: "malformed_structure" });
        }
      }),
      { numRuns: 500 },
    );
  });
});
