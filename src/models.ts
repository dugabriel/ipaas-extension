// Shared data models for the extension (JwtClaims, Role, Integration, Flow,
// Message, ExecutionStep, ...) and terminal-state helpers.
// Field names mirror the confirmed iPaaS API payloads.

// Req 2.3, 2.4 — decoded JWT claims (signature never verified)
export interface JwtClaims {
  fullName?: string;
  login?: string;
  email?: string;
  companyId?: string;
  tenantCode?: string;
  tenantIdpId?: string;
  env?: string;
  partnerCompany?: string;
  sub?: string;
  userIdpId?: string;
  exp?: number; // Unix seconds (Req 3.5-3.7)
  iat?: number;
  [claim: string]: unknown; // tolerate unknown claims
}

// Req 2.3-2.5 — structural JWT decode outcome (no signature verification)
export type JwtDecodeResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: "malformed_structure" } // not exactly 3 dot-separated segments (Req 2.4)
  | { ok: false; reason: "payload_not_json" }; // base64url payload is not valid JSON (Req 2.5)

// Req 4 — Roles_API response
export interface Role {
  name: string;
  type: string;
  gatewayEnabled: boolean;
  features: FeaturePermission[];
}
export interface FeaturePermission {
  id: string;
  name: string;
}

// Req 5 — Integrations_API first item
export interface Integration {
  id: string;
  name: string;
  active: boolean;
  status: string; // "PUBLISHED" gates execute (Req 8)
  flow: Flow;
}
export interface Flow {
  async: boolean;
  functions: Record<string, FlowFunction>;
  activities: Record<string, FlowActivity>;
  start: string; // id into activities (Req 8.1)
  globalErrorFlow?: unknown;
}
export interface FlowFunction {
  id: string;
  name: string;
  type: string; // e.g. "FUNCTION_JOLT"
  label: string;
  params?: unknown;
  componentId: string;
  componentResourceId: string;
  connections?: unknown;
}
export interface FlowActivity {
  type: string; // "WEBHOOK", "CONDITION", ...
  ownerTenantName?: string;
  componentAccountId?: string;
  serviceId?: string;
  isCustom?: boolean;
  shared?: boolean;
  configurations?: ConditionConfig; // present for CONDITION
}
export interface ConditionConfig {
  conditionType: string;
  conditions: ConditionClauseRaw[];
}
export interface ConditionClauseRaw {
  input: string;
  operation: string;
  booleanOperator?: string;
}

// Req 9 — Keys_API entries
export interface ExecutionKey {
  id: string;
  integrationId: string;
  apiKey: string;
  eai: boolean;
  noContent: boolean; // Req 11.3
  sync: boolean;
  diagram: { id: string; name: string };
  project: { id: string; name: string; type: string };
}

// Req 11 — Execute_API response (messageId may be absent)
export interface ExecutionResponse {
  status: string;
  messageId?: string; // absent → no tracking id (Req 11.3)
  timestamp: string;
}

// Req 12, 14 — Message_Detail / Child_Messages
export type MessageStatus = "PROCESSING" | "DONE" | "ERROR" | "REPROCESSED";
export interface Message {
  id: string;
  integrationId: string;
  diagramId: string;
  diagramName: string;
  status: MessageStatus;
  executionTime: number;
  initialComponent: string;
  finalComponent: string;
  sourceType: "ORIGINAL" | "SPLITTED";
  originMessageId?: string;
  totalSplitMessage: number; // >0 → poll children (Req 14.1)
  message?: unknown; // Sensitive_Payload (Req 17)
}

// Req 13 — Steps_API entries
export type StepStatus = "PROCESSING" | "DONE" | "ERROR" | "REPROCESSED";
export interface ExecutionStep {
  messageId: string;
  componentId: string; // targets canvas node (Req 15)
  activityLabel: string;
  status: StepStatus;
  startDate: string;
  endDate?: string;
  inMessage?: unknown; // Sensitive_Payload (Req 17)
  outMessage?: unknown; // Sensitive_Payload (Req 17)
  inHeaders?: unknown; // Sensitive_Payload (Req 17)
  outHeaders?: unknown; // Sensitive_Payload (Req 17)
  functions?: unknown;
  condition?: unknown;
  resourceType?: string;
}

// Terminal state helper (Req 12.4, 13, 14.4)
export const TERMINAL: ReadonlySet<string> = new Set(["DONE", "ERROR"]);
export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export interface DateWindow {
  initialDate: string;
  finalDate: string;
}
