// Feature: ipaas-helper-extension, Property 6: Session field mapping with per-field fallback
//
// Property statement: For any decoded JwtClaims object, the Session_Panel
// view-model maps Company, User, and environment each independently; the absence
// of any one field never changes the mapped result of another field.
//
// Company is a composite: the human-readable tenant slug (`domain`, falling back
// to `tenantCode`) paired with the `companyId` UUID as "{slug} ({id})"; when only
// one part is present that part is shown; NOT_AVAILABLE when neither is.
// User and environment are single-source with a non-empty-string fallback.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { JwtClaims } from "../../src/models";
import {
  mapCompany,
  mapUser,
  mapEnv,
  NOT_AVAILABLE,
} from "../../src/popup/session-view";

type FieldState =
  | { kind: "absent" }
  | { kind: "empty" }
  | { kind: "nonstring"; value: unknown }
  | { kind: "present"; value: string };

const fieldStateArb: fc.Arbitrary<FieldState> = fc.oneof(
  fc.constant<FieldState>({ kind: "absent" }),
  fc.constant<FieldState>({ kind: "empty" }),
  fc
    .oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.double({ noNaN: true }))
    .map<FieldState>((value) => ({ kind: "nonstring", value })),
  fc.string({ minLength: 1 }).map<FieldState>((value) => ({ kind: "present", value })),
);

/** The usable (non-empty string) value of a field state, else null. */
function usable(state: FieldState): string | null {
  return state.kind === "present" ? state.value : null;
}

function applyField(claims: JwtClaims, key: string, state: FieldState): void {
  switch (state.kind) {
    case "absent":
      delete claims[key];
      break;
    case "empty":
      claims[key] = "";
      break;
    case "nonstring":
    case "present":
      claims[key] = state.value;
      break;
  }
}

/** Expected Company per the slug(domain→tenantCode)+companyId composite rule. */
function expectedCompany(
  domain: FieldState,
  tenantCode: FieldState,
  companyId: FieldState,
): string {
  const slug = usable(domain) ?? usable(tenantCode);
  const id = usable(companyId);
  if (slug !== null && id !== null) return `${slug} (${id})`;
  return slug ?? id ?? NOT_AVAILABLE;
}

describe("Feature: ipaas-helper-extension, Property 6: Session field mapping with per-field fallback", () => {
  it("maps Company (slug+UUID), User, and env each per their own claims", () => {
    fc.assert(
      fc.property(
        fieldStateArb, // domain
        fieldStateArb, // tenantCode
        fieldStateArb, // companyId
        fieldStateArb, // user (via fullName)
        fieldStateArb, // env
        (domain, tenantCode, companyId, user, env) => {
          const claims: JwtClaims = {};
          applyField(claims, "domain", domain);
          applyField(claims, "tenantCode", tenantCode);
          applyField(claims, "companyId", companyId);
          delete claims.login;
          delete claims.email;
          applyField(claims, "fullName", user);
          applyField(claims, "env", env);

          expect(mapCompany(claims)).toBe(
            expectedCompany(domain, tenantCode, companyId),
          );
          expect(mapUser(claims)).toBe(usable(user) ?? NOT_AVAILABLE);
          expect(mapEnv(claims)).toBe(usable(env) ?? NOT_AVAILABLE);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never lets User or env mapping be changed by the Company fields (independence)", () => {
    fc.assert(
      fc.property(
        fieldStateArb, // user
        fieldStateArb, // env
        fieldStateArb, // companyId variant A
        fieldStateArb, // companyId variant B
        (user, env, companyA, companyB) => {
          const build = (company: FieldState): JwtClaims => {
            const c: JwtClaims = {};
            applyField(c, "companyId", company);
            delete c.login;
            delete c.email;
            applyField(c, "fullName", user);
            applyField(c, "env", env);
            return c;
          };
          const a = build(companyA);
          const b = build(companyB);
          // Changing the Company field must not alter User or env.
          expect(mapUser(a)).toBe(mapUser(b));
          expect(mapEnv(a)).toBe(mapEnv(b));
          expect(mapUser(a)).toBe(usable(user) ?? NOT_AVAILABLE);
          expect(mapEnv(a)).toBe(usable(env) ?? NOT_AVAILABLE);
        },
      ),
      { numRuns: 100 },
    );
  });
});
