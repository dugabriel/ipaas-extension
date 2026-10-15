// Feature: ipaas-helper-extension, Property 14: Execution-modal submit gating
//
// Property statement: For any body input and header input, canSubmit returns
// true iff the body parses as valid JSON AND every non-blank header line is a
// well-formed name-and-value pair; when either validator fails, submission is
// blocked.
//
// Validates: Requirements 10.2, 10.3, 10.4
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  canSubmit,
  validateBody,
  validateHeaders,
} from "../../src/builder/execution-modal";

// --- Body generators ---------------------------------------------------------

// Valid JSON bodies: serialize any JSON-safe value so it round-trips through
// JSON.parse.
const validBody = fc.jsonValue().map((v) => JSON.stringify(v));

// Invalid JSON bodies: arbitrary strings that fail to parse as JSON. We filter
// out the (rare) strings that happen to be valid JSON so the arbitrary only
// ever produces genuinely invalid input.
const invalidBody = fc.string().filter((s) => !validateBody(s).ok);

const anyBody = fc.oneof(validBody, invalidBody);

// --- Header generators --------------------------------------------------------

// RFC 7230 field-name (token) characters — mirrors FIELD_NAME_RE in the source.
const TCHAR = "!#$%&'*+-.^_`|~0123456789" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const tcharArb = fc.constantFrom(...TCHAR.split(""));

// A valid header name: one or more token characters.
const validName = fc.array(tcharArb, { minLength: 1, maxLength: 20 }).map((cs) =>
  cs.join(""),
);

// A valid header value: printable characters free of C0 controls and DEL. The
// validator trims the edges, so internal spaces are fine. We draw from code
// points at or above U+0020 while excluding U+007F.
const valueChar = fc
  .integer({ min: 0x20, max: 0x7e })
  .map((n) => String.fromCharCode(n));
const validValue = fc.array(valueChar, { maxLength: 20 }).map((cs) => cs.join(""));

// A single valid, non-blank header line: `name: value`. Guard against the value
// trimming down to a form that would re-introduce ambiguity is unnecessary —
// any token name plus a control-free value is accepted by validateHeaders.
const validHeaderLine = fc
  .tuple(validName, validValue)
  .map(([name, value]) => `${name}: ${value}`);

// Blank lines (whitespace only) are ignored by the validator.
const blankLine = fc.constantFrom("", " ", "  ", "\t", " \t ");

// A valid header block: a mix of valid lines and blank lines, joined by
// newlines. An all-blank (or empty) block is also valid.
const validHeaders = fc
  .array(fc.oneof(validHeaderLine, blankLine), { maxLength: 8 })
  .map((lines) => lines.join("\n"));

// Invalid header lines — three distinct ways a non-blank line can be malformed:
//
//  1. Missing colon: a non-blank line with no ":".
//  2. Invalid name chars: a name containing a character outside the token set.
//  3. Control char in value: a value containing a C0 control or DEL.
const noColonLine = fc
  .string({ minLength: 1 })
  .map((s) => s.replace(/:/g, ""))
  .filter((s) => s.trim() !== ""); // must be non-blank to be checked

const badName = fc
  .tuple(
    fc.array(tcharArb, { maxLength: 5 }).map((cs) => cs.join("")),
    // A character that is NOT a token char and not a colon (colon would split
    // the name early) and not whitespace at the edges.
    fc.constantFrom("(", ")", "@", "/", "[", "]", "?", "=", "{", "}", " "),
    fc.array(tcharArb, { maxLength: 5 }).map((cs) => cs.join("")),
  )
  .map(([a, bad, b]) => `${a}${bad}${b}`)
  .filter((name) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name.trim()) === false)
  .filter((name) => name.trim() !== "");
const badNameLine = fc
  .tuple(badName, validValue)
  .map(([name, value]) => `${name}: ${value}`);

const controlChar = fc
  .integer({ min: 0, max: 0x1f })
  .map((n) => String.fromCharCode(n));
const badValueLine = fc
  .tuple(validName, controlChar, validValue)
  .map(([name, ctrl, rest]) => `${name}: val${ctrl}${rest}`);

const invalidHeaderLine = fc.oneof(noColonLine, badNameLine, badValueLine);

// An invalid header block contains at least one invalid non-blank line (plus
// optionally some valid/blank lines). Placing the invalid line guarantees the
// whole block is rejected.
const invalidHeaders = fc
  .tuple(
    fc.array(fc.oneof(validHeaderLine, blankLine), { maxLength: 4 }),
    invalidHeaderLine,
    fc.array(fc.oneof(validHeaderLine, blankLine), { maxLength: 4 }),
  )
  .map(([before, bad, after]) => [...before, bad, ...after].join("\n"))
  .filter((block) => !validateHeaders(block).ok); // confirm it is truly invalid

const anyHeaders = fc.oneof(validHeaders, invalidHeaders);

describe("Feature: ipaas-helper-extension, Property 14: Execution-modal submit gating", () => {
  it("canSubmit is true iff body is valid JSON and every non-blank header line is well-formed", () => {
    fc.assert(
      fc.property(anyBody, anyHeaders, (bodyRaw, headersRaw) => {
        const bodyOk = validateBody(bodyRaw).ok;
        const headersOk = validateHeaders(headersRaw).ok;

        // canSubmit mirrors the conjunction of the two independent validators.
        expect(canSubmit(bodyRaw, headersRaw)).toBe(bodyOk && headersOk);

        // Submission is permitted exactly when both validators independently
        // succeed, and blocked whenever either fails.
        expect(canSubmit(bodyRaw, headersRaw)).toBe(
          bodyOk === true && headersOk === true,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("canSubmit is true for independently valid body + headers", () => {
    fc.assert(
      fc.property(validBody, validHeaders, (bodyRaw, headersRaw) => {
        expect(canSubmit(bodyRaw, headersRaw)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("canSubmit is false whenever either input is invalid", () => {
    fc.assert(
      fc.property(
        fc.oneof(validBody, invalidBody),
        fc.oneof(validHeaders, invalidHeaders),
        (bodyRaw, headersRaw) => {
          const bodyOk = validateBody(bodyRaw).ok;
          const headersOk = validateHeaders(headersRaw).ok;
          if (!bodyOk || !headersOk) {
            expect(canSubmit(bodyRaw, headersRaw)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
