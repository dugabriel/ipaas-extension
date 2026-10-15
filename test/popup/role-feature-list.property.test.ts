// Feature: ipaas-helper-extension, Property 9: Role feature-list completeness
//
// Property statement: For any successful Role response, the rendered feature
// list contains the name of every entry in the Role features array, with no
// feature omitted or duplicated.
//
// toRoleSection(result) maps an ApiResult<Role> to a RoleSection; for the `ok`
// case the feature list is result.data.features.map(f => f.name). This test
// asserts that list is exactly the ordered list of each feature's name — same
// length, same multiset, same order — so no feature is dropped and no
// duplication is introduced beyond what the source array already contains.
//
// Validates: Requirements 4.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { toRoleSection } from "../../src/popup/render";
import type { FeaturePermission, Role } from "../../src/models";
import type { ApiResult } from "../../src/messaging/protocol";

// A single feature permission. The name is drawn from a small pool so that
// duplicate names arise naturally across a generated features array (Req 4.4
// must hold even when two features share a name).
const feature: fc.Arbitrary<FeaturePermission> = fc.record({
  id: fc.string(),
  name: fc.oneof(
    fc.constantFrom("read", "write", "admin", "execute", "view"),
    fc.string(),
  ),
});

// A Role whose features array has arbitrary length, including empty, and may
// contain duplicate feature names.
const role: fc.Arbitrary<Role> = fc.record({
  name: fc.string(),
  type: fc.string(),
  gatewayEnabled: fc.boolean(),
  features: fc.array(feature, { minLength: 0, maxLength: 12 }),
});

describe("Feature: ipaas-helper-extension, Property 9: Role feature-list completeness", () => {
  it("renders exactly the ordered names of every Role feature, with no omission or added duplication", () => {
    fc.assert(
      fc.property(role, (data) => {
        const result: ApiResult<Role> = { ok: true, data };
        const section = toRoleSection(result);

        // A successful Role response always maps to the "role" branch.
        expect(section.kind).toBe("role");
        if (section.kind !== "role") return;

        const expectedNames = data.features.map((f) => f.name);

        // Same length: no feature omitted, none added.
        expect(section.features.length).toBe(expectedNames.length);

        // Same order and same values element-for-element: this is the strongest
        // statement — it implies the same multiset with no reordering, no
        // omission, and no added duplication beyond the source array.
        expect(section.features).toEqual(expectedNames);
      }),
      { numRuns: 100 },
    );
  });
});
