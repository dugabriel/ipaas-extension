// Feature: ipaas-helper-extension, Property 5: Diagram id extraction
//
// Property statement: For any Builder_Page URL whose path matches
// `/builder/{diagramId}`, the extracted Diagram_Id equals that path segment.
//
// Validates: Requirements 5.1
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractDiagramId } from "../../src/builder/activation";

// A diagram segment is a non-empty string that contains no path/query/fragment
// delimiters, so `/builder/{seg}` has exactly one segment after `/builder/`.
const diagramSegment = fc
  .string({ minLength: 1 })
  .filter((s) => !/[/?#]/.test(s));

describe("Feature: ipaas-helper-extension, Property 5: Diagram id extraction", () => {
  it("returns exactly the single path segment after /builder/", () => {
    fc.assert(
      fc.property(diagramSegment, fc.boolean(), (segment, trailingSlash) => {
        const path = `/builder/${segment}${trailingSlash ? "/" : ""}`;
        expect(extractDiagramId(path)).toBe(segment);
      }),
      { numRuns: 100 },
    );
  });

  it("returns null for non-builder and multi-segment paths", () => {
    // Non-builder paths: a first segment that is not `builder`.
    const nonBuilderPath = fc
      .string({ minLength: 1 })
      .filter((s) => !/[/?#]/.test(s) && s !== "builder")
      .map((first) => `/${first}`);

    // Multi-segment builder paths: two or more non-empty segments after
    // `/builder/`, which must not resolve to a single Diagram_Id.
    const multiSegmentBuilderPath = fc
      .array(diagramSegment, { minLength: 2, maxLength: 5 })
      .map((segs) => `/builder/${segs.join("/")}`);

    fc.assert(
      fc.property(
        fc.oneof(
          nonBuilderPath,
          multiSegmentBuilderPath,
          // `/builder` and `/builder/` have zero segments after `/builder/`.
          fc.constantFrom("/builder", "/builder/", "/", ""),
        ),
        (path) => {
          expect(extractDiagramId(path)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
