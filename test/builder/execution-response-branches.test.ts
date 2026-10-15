// Feature: ipaas-helper-extension — execution-response branch mapping.
//
// Unit tests for `resolveExecutionOutcome` (src/builder/execution-flow.ts): the
// pure mapping from an EXECUTE ApiResult to a UI ExecutionOutcome.
//
//  - ok with messageId present -> tracking (captures messageId/status/timestamp) (Req 11.2);
//  - ok with messageId absent/empty -> no_tracking_id (triggered, no tracking id) (Req 11.3);
//  - 401 -> unauthorized (re-auth) (Req 11.4);
//  - any other failure (http_error/network/timeout/no_session) -> trigger_failed (Req 11.5).
//
// Validates: Requirements 11.2, 11.3, 11.4
import { describe, it, expect } from "vitest";
import {
  resolveExecutionOutcome,
  EXECUTION_MESSAGES,
} from "../../src/builder/execution-flow";
import type { SelectedKey } from "../../src/builder/key-selection";
import type { ApiResult } from "../../src/messaging/protocol";
import type { ExecutionResponse } from "../../src/models";

// The selectedKey is accepted for context but does not change the branch, so a
// single inert value is reused across cases.
const selectedKey: SelectedKey = { apiKey: "k", sync: true, noContent: false };

function ok(data: ExecutionResponse): ApiResult<ExecutionResponse> {
  return { ok: true, data };
}

describe("Feature: ipaas-helper-extension — resolveExecutionOutcome branches", () => {
  describe("success with a tracking id (Req 11.2)", () => {
    it("maps a present messageId to tracking, capturing messageId/status/timestamp", () => {
      const result = ok({
        messageId: "msg-123",
        status: "PROCESSING",
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "tracking",
        messageId: "msg-123",
        status: "PROCESSING",
        timestamp: "2024-01-01T00:00:00Z",
      });
    });
  });

  describe("success without a tracking id (Req 11.3)", () => {
    it("maps an undefined messageId to no_tracking_id", () => {
      const result = ok({ status: "DONE", timestamp: "2024-01-01T00:00:00Z" });

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "no_tracking_id",
        message: EXECUTION_MESSAGES.no_tracking_id,
      });
    });

    it("maps an empty-string messageId to no_tracking_id", () => {
      const result = ok({
        messageId: "",
        status: "DONE",
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "no_tracking_id",
        message: EXECUTION_MESSAGES.no_tracking_id,
      });
    });
  });

  describe("unauthorized (Req 11.4)", () => {
    it("maps a 401 failure to unauthorized with the re-auth message", () => {
      const result: ApiResult<ExecutionResponse> = {
        ok: false,
        kind: "unauthorized",
      };

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "unauthorized",
        message: EXECUTION_MESSAGES.unauthorized,
      });
    });
  });

  describe("other failures -> trigger_failed (Req 11.5)", () => {
    it("maps an http_error failure to trigger_failed", () => {
      const result: ApiResult<ExecutionResponse> = {
        ok: false,
        kind: "http_error",
        status: 500,
      };

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "trigger_failed",
        message: EXECUTION_MESSAGES.trigger_failed,
      });
    });

    it("maps a network failure to trigger_failed", () => {
      const result: ApiResult<ExecutionResponse> = {
        ok: false,
        kind: "network",
      };

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "trigger_failed",
        message: EXECUTION_MESSAGES.trigger_failed,
      });
    });

    it("maps a timeout failure to trigger_failed", () => {
      const result: ApiResult<ExecutionResponse> = {
        ok: false,
        kind: "timeout",
      };

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "trigger_failed",
        message: EXECUTION_MESSAGES.trigger_failed,
      });
    });

    it("maps a no_session failure to trigger_failed", () => {
      const result: ApiResult<ExecutionResponse> = {
        ok: false,
        kind: "no_session",
      };

      expect(resolveExecutionOutcome(result, selectedKey)).toEqual({
        kind: "trigger_failed",
        message: EXECUTION_MESSAGES.trigger_failed,
      });
    });
  });
});
