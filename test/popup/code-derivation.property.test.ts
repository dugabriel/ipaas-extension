// Feature: ipaas-helper-extension, Property 8: User and tenant code derivation
//
// Property statement: For any decoded JwtClaims, the User_Code resolves to the
// `userIdpId` claim (the IdP user UUID) and the Tenant_Code resolves to the
// `tenantIdpId` claim (the IdP tenant UUID); when a source claim is absent or
// not a non-empty string, that code falls back to NOT_AVAILABLE.
//
// Rationale (validated against the live Roles_API): the endpoint is keyed by the
// IdP UUIDs, not by `sub` (an email) or `tenantCode` (a slug), which return 404.
//
// Validates: Requirements 4.1
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { deriveCodes, NOT_AVAILABLE } from "../../src/popup/session-view";
import type { JwtClaims } from "../../src/models";

/**
 * Generator for a single claim slot that is INDEPENDENTLY one of:
 *  - a non-empty string (the "present and usable" case)
 *  - the empty string (present but falls back, per the implementation)
 *  - absent (the key is omitted entirely)
 *  - a non-string value (number/boolean/null/object — also falls back)
 */
const claimSlot = (key: keyof JwtClaims) =>
  fc.oneof(
    fc.string({ minLength: 1 }).filter((s) => s !== "").map((v) => ({ [key]: v })),
    fc.constant({ [key]: "" }),
    fc.constant({}),
    fc
      .oneof(
        fc.integer(),
        fc.double({ noNaN: true }),
        fc.boolean(),
        fc.constant(null),
        fc.object({ maxDepth: 1 }),
      )
      .map((v) => ({ [key]: v })),
  );

/** Oracle mirroring the implementation: a claim contributes only when it is a non-empty string. */
function usableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

describe("Feature: ipaas-helper-extension, Property 8: User and tenant code derivation", () => {
  it("derives userCode from userIdpId and tenantCode from tenantIdpId, with N/A fallback", () => {
    fc.assert(
      fc.property(
        claimSlot("userIdpId"),
        claimSlot("tenantIdpId"),
        // Noise claims that MUST NOT influence the derivation (the old rule
        // used these; they must now be ignored).
        claimSlot("sub"),
        claimSlot("tenantCode"),
        (userIdpPart, tenantIdpPart, subPart, tenantCodePart) => {
          const claims = {
            ...subPart,
            ...tenantCodePart,
            ...userIdpPart,
            ...tenantIdpPart,
          } as JwtClaims;

          const { userCode, tenantCode } = deriveCodes(claims);

          const expectedUserCode = usableString(claims.userIdpId) ?? NOT_AVAILABLE;
          const expectedTenantCode = usableString(claims.tenantIdpId) ?? NOT_AVAILABLE;

          expect(userCode).toBe(expectedUserCode);
          expect(tenantCode).toBe(expectedTenantCode);

          // `sub` and `tenantCode` never drive the result anymore.
          if (usableString(claims.userIdpId) === null) {
            expect(userCode).toBe(NOT_AVAILABLE);
          }
          if (usableString(claims.tenantIdpId) === null) {
            expect(tenantCode).toBe(NOT_AVAILABLE);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
