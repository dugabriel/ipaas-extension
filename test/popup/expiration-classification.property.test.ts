// Feature: ipaas-helper-extension, Property 7: Expiration classification
//
// Property statement: For any `exp` value and any reference time `now`, the
// Session_Panel classifies the session as expired iff `exp` is a valid
// Unix-timestamp integer earlier than `now`, active when it is a valid
// timestamp not earlier than `now`, and unavailable when `exp` is absent or
// not a valid integer -- and in every case the other decoded values are
// retained.
//
// Validates: Requirements 3.6, 3.7
//
// Note on units: `now` is epoch-milliseconds while `exp` is interpreted as
// Unix seconds, so the oracle compares `exp * 1000` against `now`, mirroring
// classifyExpiration in src/popup/session-view.ts.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { JwtClaims } from "../../src/models";
import {
  classifyExpiration,
  type ExpirationStatus,
} from "../../src/popup/session-view";

/**
 * Oracle for the valid-timestamp check: a value is a valid Unix timestamp only
 * when it is a finite integer number. Non-numbers, floats, NaN, and Infinity
 * are invalid (Req 3.7).
 */
function isValidUnixTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Independent oracle for the expected classification given `exp` and `now`.
 * - unavailable when `exp` is absent / not a valid integer
 * - expired     when `exp * 1000` is strictly earlier than `now`
 * - active       when `exp * 1000` is not earlier than `now` (including equal)
 */
function expectedStatus(exp: unknown, now: number): ExpirationStatus {
  if (!isValidUnixTimestamp(exp)) return "unavailable";
  return exp * 1000 < now ? "expired" : "active";
}

// Other claim values the function must retain untouched on the input object.
const otherClaims = fc.record(
  {
    fullName: fc.string(),
    login: fc.string(),
    email: fc.string(),
    companyId: fc.string(),
    tenantCode: fc.string(),
    env: fc.string(),
    sub: fc.string(),
    userIdpId: fc.string(),
  },
  { requiredKeys: [] },
);

// `exp` generator covering all three input classes.
const expArbitrary = fc.oneof(
  // (a) valid integers (negative, zero, positive) across a wide range.
  fc.integer({ min: -(2 ** 31), max: 2 ** 34 }),
  // (b) absent / undefined.
  fc.constant(undefined),
  // (c) non-integer values: floats, NaN, Infinity, strings, booleans, null, objects.
  fc.double({ noInteger: true }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.object(),
);

// `now` as an arbitrary epoch-ms reference time (wide range incl. negatives).
const nowArbitrary = fc.integer({ min: -(2 ** 40), max: 2 ** 44 });

describe("Feature: ipaas-helper-extension, Property 7: Expiration classification", () => {
  it("classifies expired/active/unavailable per the oracle and retains other decoded values", () => {
    fc.assert(
      fc.property(otherClaims, expArbitrary, nowArbitrary, (others, exp, now) => {
        const claims = { ...others, exp } as unknown as JwtClaims;
        // Snapshot the non-exp claims to assert retention afterward.
        const beforeOthers = JSON.stringify(others);

        const result = classifyExpiration(claims, now);

        // 1. Status matches the independent oracle.
        expect(result.status).toBe(expectedStatus(exp, now));

        // 2. Display is a non-null local date/time string exactly when the
        //    status is not "unavailable", and null when unavailable.
        if (result.status === "unavailable") {
          expect(result.display).toBeNull();
        } else {
          expect(typeof result.display).toBe("string");
          expect(result.display).toBe(new Date((exp as number) * 1000).toLocaleString());
        }

        // 3. The other decoded values on the claims object are retained
        //    unchanged (the function does not drop or mutate them).
        for (const key of Object.keys(others)) {
          expect(claims[key]).toBe((others as Record<string, unknown>)[key]);
        }
        expect(JSON.stringify(others)).toBe(beforeOthers);
      }),
      { numRuns: 100 },
    );
  });
});
