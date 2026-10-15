// Feature: ipaas-helper-extension, Property 4: Builder path-activation guard
//
// Property statement: For any URL path, the builder activation guard returns
// true iff the path matches `/builder/{diagramId}` with a single non-empty
// diagram segment.
//
// Validates: Requirements 1.3
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isBuilderPath } from "../../src/builder/activation";

/**
 * Independent oracle: decide whether `path` is a builder path purely from its
 * segments, without reusing the implementation's helpers. A path activates iff,
 * after dropping empty segments (from leading/trailing/duplicate slashes) and
 * stripping any query string or fragment, the segments are exactly
 * `["builder", <one non-empty segment>]`.
 */
function oracleIsBuilderPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  const segments = pathname.split("/").filter((s) => s.length > 0);
  return segments.length === 2 && segments[0] === "builder";
}

// A path segment that is non-empty and contains none of the structural
// characters that would change the segmentation (slash, query, fragment).
const diagramSegment = fc
  .string({ minLength: 1 })
  .filter((s) => !/[/?#]/.test(s) && s.length > 0);

// Generators for valid builder paths: exactly one non-empty segment after
// `/builder/`, with or without a trailing slash.
const validBuilderPath = fc.oneof(
  diagramSegment.map((seg) => `/builder/${seg}`),
  diagramSegment.map((seg) => `/builder/${seg}/`),
);

// Generators for paths that must NOT activate.
const invalidPath = fc.oneof(
  // Zero segments after /builder/.
  fc.constantFrom("/builder/", "/builder", "/builder//", "builder", ""),
  // Two or more segments after /builder/.
  fc
    .array(diagramSegment, { minLength: 2, maxLength: 5 })
    .map((segs) => `/builder/${segs.join("/")}`),
  // A different first segment.
  fc
    .tuple(
      diagramSegment.filter((s) => s !== "builder"),
      diagramSegment,
    )
    .map(([first, second]) => `/${first}/${second}`),
  // Entirely arbitrary paths.
  fc.webPath(),
  fc.string(),
);

// Union of valid and invalid generators so the oracle — not the generator —
// decides the expected answer for every input.
const anyPath = fc.oneof(validBuilderPath, invalidPath);

describe("Feature: ipaas-helper-extension, Property 4: Builder path-activation guard", () => {
  it("returns true iff the path has a single non-empty segment after /builder/", () => {
    fc.assert(
      fc.property(anyPath, (path) => {
        expect(isBuilderPath(path)).toBe(oracleIsBuilderPath(path));
      }),
      { numRuns: 100 },
    );
  });

  it("returns true for valid /builder/{diagramId} paths", () => {
    fc.assert(
      fc.property(validBuilderPath, (path) => {
        expect(isBuilderPath(path)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("returns false for paths without a single non-empty diagram segment", () => {
    fc.assert(
      fc.property(invalidPath, (path) => {
        // Guard: a webPath()/string() could coincidentally be a valid builder
        // path; only assert false for inputs the oracle agrees are invalid.
        fc.pre(!oracleIsBuilderPath(path));
        expect(isBuilderPath(path)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
