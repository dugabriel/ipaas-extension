# Implementation Plan: iPaaS Helper Extension

## Overview

This plan builds the Chrome Manifest V3 extension incrementally in TypeScript, test-driven. It starts with project scaffolding and the manifest, then the shared models, then the trusted service-worker core (AuthService, ApiClient), then the popup SessionPanel, then the builder content-script flow (loading, BuilderHelpers, ExecutionModal, key resolution, execution trigger), then the ExecutionTracker state machine, then the best-effort CanvasHighlighter, and finally wiring and integration tests.

Pure functions with large input spaces (JWT decoder, builder resolvers, modal validators, key selector, tracker terminal/aggregation logic, ApiClient classification) are covered by property-based tests using `fast-check` + Vitest, one test per property (Properties 1–24), each running at least 100 iterations. I/O, UI, timing, and configuration are covered by example, unit, integration/DOM, and smoke tests per the design's Testing Strategy.

## Tasks

- [x] 1. Scaffold the extension project, build pipeline, and manifest
  - Initialize a TypeScript MV3 project with Vite + `@crxjs/vite-plugin`; add `vite.config.ts` with popup, content, and background entries
  - Configure Vitest with `fast-check`, `jsdom`, and a mocked `chrome.*` API (`sinon-chrome`); add test scripts
  - Create the `src/` directory structure (`background.ts`, `content.ts`, `popup.html`/`popup.ts`, `models.ts`, `auth/`, `api/`, `builder/`, `tracking/`, `messaging/`) and the `test/` tree (`dom/`, `smoke/`) as placeholder entry stubs
  - Author `manifest.json`: `manifest_version` 3, `permissions: ["cookies"]`, `host_permissions` limited to exactly the three allowed hosts, module service worker, `action.default_popup`, and a content script matching `https://ipaas.totvs.app/builder/*` at `document_idle`
  - _Requirements: 1.4, 1.5_

  - [x] 1.1 Write manifest smoke tests
    - Assert `host_permissions` equals exactly `https://ipaas.totvs.app/`, `https://api-ipaas.totvs.app/`, `https://api-fluig.totvs.app/` and nothing else
    - Assert `action.default_popup` is set, no content script injects the panel, and the `cookies` permission is present
    - _Requirements: 1.4, 1.5_

- [x] 2. Define shared data models and the messaging protocol
  - [x] 2.1 Implement `src/models.ts`
    - Define `JwtClaims`, `JwtDecodeResult`, `Role`, `FeaturePermission`, `Integration`, `Flow`, `FlowFunction`, `FlowActivity`, `ConditionConfig`, `ConditionClauseRaw`, `ExecutionKey`, `ExecutionResponse`, `Message`, `MessageStatus`, `ExecutionStep`, `StepStatus`, `DateWindow`
    - Add the `TERMINAL` set and the `isTerminal(status)` helper
    - _Requirements: 2.3, 3.5, 4.1, 5.3, 9.2, 11.2, 12.2, 13.2, 14.1_

  - [x] 2.2 Implement `src/messaging/protocol.ts`
    - Define the typed discriminated-union request/response messages (`GET_SESSION`, `GET_ROLE`, `GET_FLOW`, `GET_KEYS`, `EXECUTE`, `TRACK_START`, `TRACK_STOP`) and the `ApiResult<T>` type
    - Define the long-lived tracking `Port` update contract
    - _Requirements: 16.1, 18.1, 18.2, 18.3_

- [x] 3. Implement AuthService (service worker)
  - [x] 3.1 Implement JWT decoding and Bearer construction in `src/auth/auth-service.ts`
    - `decodeJwt`: split on `.`, require exactly three segments, Base64URL-decode only the payload segment and `JSON.parse` it; return `malformed_structure` / `payload_not_json` on failure; never inspect the signature
    - `buildBearerHeader`: build `Bearer {token}`; throw/flag no-session when the token is missing
    - `readSessionToken`: read `jwt.token` via `chrome.cookies`, returning null when absent/empty
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 16.1, 16.3_

  - [x] 3.2 Write property test for JWT payload decode round-trip
    - **Property 1: JWT payload decode round-trip**
    - **Validates: Requirements 2.3**

  - [x] 3.3 Write property test for malformed token structure detection
    - **Property 2: Malformed token structure detection**
    - **Validates: Requirements 2.4**

  - [x] 3.4 Write property test for undecodable payload detection
    - **Property 3: Undecodable payload detection**
    - **Validates: Requirements 2.5**

  - [x] 3.5 Write integration test for the cookie read
    - Read `jwt.token` from `ipaas.totvs.app` via a mocked `chrome.cookies`; assert null on absent/empty
    - _Requirements: 2.1_

- [x] 4. Implement ApiClient (service worker)
  - [x] 4.1 Implement the ApiClient core and typed endpoint wrappers in `src/api/api-client.ts`
    - Resolve the Bearer header per call (short-circuit `no_session` with no outbound request when the cookie is empty), wrap every `fetch` in a 30s `AbortController`, and map outcomes to `ApiResult` (`unauthorized`/`http_error`/`network`/`timeout`)
    - Implement `getRole`, `getIntegration` (first-item selection), `getKeys` (body `{}`), `execute`, `getMessage`, `getSteps`, `getChildMessages` with their exact URLs, query params, and bodies
    - _Requirements: 4.2, 5.2, 5.3, 9.1, 11.1, 13.1, 14.1, 16.1, 16.2, 16.3, 17.2, 17.3, 18.1, 18.2, 18.3_

  - [x] 4.2 Write property test for Bearer header injection
    - **Property 20: Bearer header injection**
    - **Validates: Requirements 16.1**

  - [x] 4.3 Write property test for unauthorized classification
    - **Property 21: Unauthorized classification**
    - **Validates: Requirements 16.2**

  - [x] 4.4 Write property test for the no-session guard
    - **Property 22: No-session guard**
    - **Validates: Requirements 16.3**

  - [x] 4.5 Write property test for allowed-host restriction
    - **Property 23: Allowed-host restriction**
    - **Validates: Requirements 17.2, 17.3**

  - [x] 4.6 Write property test for error-outcome classification
    - **Property 24: Error-outcome classification**
    - **Validates: Requirements 18.1, 18.2, 18.3**

  - [x] 4.7 Write unit tests for per-endpoint request construction
    - Assert Roles_API query + Bearer, Integrations_API `fieldsReturn`/`pageSize=1` + first-item selection, Keys_API body `{}`, Execute_API POST shape, Steps_API path, Child_Messages_API query
    - _Requirements: 4.2, 5.2, 5.3, 9.1, 11.1, 13.1_

- [x] 5. Checkpoint — core service-worker foundation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement SessionPanel popup
  - [x] 6.1 Implement session field mapping and expiration classification helpers
    - Map Company, User, and `env` independently with a per-field not-available fallback
    - Derive User_Code (`sub` then `userIdpId`) and Tenant_Code (`tenantCode`)
    - Classify expiration as expired/active/unavailable against `now`, retaining other decoded values; format `exp` as local date/time
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1_

  - [x] 6.2 Write property test for session field mapping with per-field fallback
    - **Property 6: Session field mapping with per-field fallback**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

  - [x] 6.3 Write property test for expiration classification
    - **Property 7: Expiration classification**
    - **Validates: Requirements 3.6, 3.7**

  - [x] 6.4 Write property test for user and tenant code derivation
    - **Property 8: User and tenant code derivation**
    - **Validates: Requirements 4.1**

  - [x] 6.5 Implement the popup rendering and role display in `popup.html`/`src/popup.ts`
    - Request decoded session + role from the worker; render Company/User/env, expiration status, and the Role `name`/`type` plus the feature list
    - Render branch messages: no session, malformed structure, undecodable payload, 401 re-auth, and "role unavailable" while keeping JWT-derived data
    - _Requirements: 2.2, 2.4, 2.5, 4.2, 4.3, 4.4, 4.5, 4.6, 16.2, 16.3_

  - [x] 6.6 Write property test for role feature-list completeness
    - **Property 9: Role feature-list completeness**
    - **Validates: Requirements 4.4**

  - [x] 6.7 Write unit tests for popup formatting and branch outcomes
    - Local date/time formatting under a fixed locale/zone; no-session, 401 re-auth, and role-unavailable branch messages
    - _Requirements: 3.5, 2.2, 4.5_

- [x] 7. Implement builder flow loading and the path-activation guard (content script)
  - [x] 7.1 Implement the builder activation guard and diagram-id extraction in `src/content.ts`
    - Activate only when the path matches `/builder/{diagramId}` with a single non-empty segment; extract the Diagram_Id from that segment
    - On activation, request the Integration via the worker (first item), expose `id`/`name`/`active`/`status`/`flow` to the helpers
    - Render flow-unavailable / 401 re-auth / could-not-load messages and keep helpers inactive on those branches
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 7.2 Write property test for the builder path-activation guard
    - **Property 4: Builder path-activation guard**
    - **Validates: Requirements 1.3**

  - [x] 7.3 Write property test for diagram id extraction
    - **Property 5: Diagram id extraction**
    - **Validates: Requirements 5.1**

  - [x] 7.4 Write integration/DOM test for activation
    - Activate on `/builder/{id}` within 2s after DOM mutations; stay inactive on non-builder paths
    - _Requirements: 1.1, 1.2_

- [x] 8. Implement BuilderHelpers resolvers (content script)
  - [x] 8.1 Implement origin resolution, condition summary, and execute precondition in `src/builder/builder-helpers.ts`
    - `resolveFunctionOrigins`: one entry per function; resolve origin from `componentId`/`componentResourceId` + matched activity metadata, else not-available, without one function affecting another
    - `summarizeConditions`: one summary per `CONDITION` activity with `conditionType` and per-clause `input`/`operation`/`booleanOperator` (null on last); flag empty clause arrays
    - `shouldShowExecuteButton`: true iff `flow.start` resolves to a WEBHOOK trigger (sync or async) AND `active` is true AND `status` is `PUBLISHED`
    - Render origins alongside each function and the condition summaries in the builder UI
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4_

  - [x] 8.2 Write property test for function-origin resolution completeness
    - **Property 10: Function-origin resolution completeness**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x] 8.3 Write property test for condition-summary completeness
    - **Property 11: Condition-summary completeness**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

  - [x] 8.4 Write property test for the execute-button precondition
    - **Property 12: Execute-button precondition**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

- [x] 9. Checkpoint — session panel and builder helpers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement the ExecutionModal (content script)
  - [x] 10.1 Implement the modal, its validators, and open-on-click in `src/builder/execution-modal.ts`
    - Provide a JSON body input and an HTTP headers input; open the modal on execute-button click
    - `validateBody`: parse JSON; `validateHeaders`: each non-blank line a single `name: value` pair with a token-valid name and a value free of control characters; `canSubmit` true iff both pass
    - Show body/headers validation messages and gate the confirm button
    - _Requirements: 8.5, 10.1, 10.2, 10.3, 10.4_

  - [x] 10.2 Write property test for execution-modal submit gating
    - **Property 14: Execution-modal submit gating**
    - **Validates: Requirements 10.2, 10.3, 10.4**

  - [x] 10.3 Write unit tests for modal rendering and open-on-click
    - Both inputs rendered; modal opens on execute-button click
    - _Requirements: 8.5, 10.1_

- [x] 11. Implement execution key resolution and execution trigger (content script + worker)
  - [x] 11.1 Implement execution-key selection
    - Select the Execution_Key whose `integrationId` equals the Integration `id` or whose `diagram.id` equals the current Diagram_Id; expose `apiKey`/`sync`/`noContent`; none when no match
    - On no match show "no execution key found" and disable triggering; handle 401 re-auth and could-not-retrieve messages
    - _Requirements: 9.2, 9.3, 9.4, 9.5_

  - [x] 11.2 Write property test for execution-key selection
    - **Property 13: Execution-key selection**
    - **Validates: Requirements 9.2, 9.3**

  - [x] 11.3 Wire confirm to execute and capture the Message_Id
    - On confirm, resolve the key, POST to the Execute_API with the user body/headers + Bearer, capture `messageId` and display `status`/`timestamp`
    - Handle the no-`messageId` case (`noContent` true or async-no-return) with "triggered, no tracking id"; handle 401 re-auth and could-not-trigger messages
    - _Requirements: 9.1, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 11.4 Write unit tests for execution-response branches
    - `messageId` present vs absent; 401 re-auth; could-not-trigger
    - _Requirements: 11.2, 11.3, 11.4_

- [x] 12. Implement the ExecutionTracker state machine (service worker)
  - [x] 12.1 Implement the polling state machine, step fetching, and child aggregation in `src/tracking/execution-tracker.ts`
    - Poll the parent Message every 3s; begin child polling only when `totalSplitMessage > 0`; reach terminal only when the parent and all `totalSplitMessage` children are terminal
    - Fetch and order steps each tick; aggregate child `DONE`/`ERROR`/`PROCESSING` counts against `totalSplitMessage`
    - On 401 stop everything; on any other error remain polling and surface the transient-failure message, retrying next tick; retain displayed data on step-fetch failure
    - Stream updates to the tracking UI over the `Port` (`status`/`executionTime`/`initialComponent`/`finalComponent`, steps, child aggregate)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 12.2 Write property test for tracker terminal detection
    - **Property 16: Tracker terminal detection**
    - **Validates: Requirements 12.3, 12.4, 14.1, 14.3, 14.4**

  - [x] 12.3 Write property test for tracker transient-error continuation
    - **Property 17: Tracker transient-error continuation**
    - **Validates: Requirements 12.6, 14.5**

  - [x] 12.4 Write property test for child-message aggregation counts
    - **Property 18: Child-message aggregation counts**
    - **Validates: Requirements 14.2**

  - [x] 12.5 Write property test for step ordering and error indication
    - **Property 15: Step ordering and error indication**
    - **Validates: Requirements 13.2, 13.3**

  - [x] 12.6 Write unit tests for tracker cadence with fake timers
    - 3-second interval; display of `status`/`executionTime`/`initialComponent`/`finalComponent`
    - _Requirements: 12.1, 12.2_

- [x] 13. Checkpoint — execution and tracking
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Implement the CanvasHighlighter (content script, best-effort)
  - [x] 14.1 Implement node targeting and status highlighting in `src/builder/canvas-highlighter.ts`
    - Target `div[id^="${componentId}"]` on the single `svg.svg-connections` canvas; apply a status-colored class via an injected stylesheet; use a `MutationObserver` for async-rendered nodes
    - `highlight` returns false when a node cannot be located so textual tracking proceeds unchanged; `clearAll` removes highlights; update highlight to terminal status on terminal steps
    - _Requirements: 15.1, 15.2, 15.3_

  - [x] 14.2 Write property test for canvas-highlighter isolation
    - **Property 19: Canvas-highlighter isolation**
    - **Validates: Requirements 15.3**

  - [x] 14.3 Write integration/DOM test against a fixture canvas
    - Node located → class applied and updated to terminal status; node absent → `highlight` returns false
    - _Requirements: 15.1, 15.2_

- [x] 15. Wire all contexts together
  - [x] 15.1 Implement the background service-worker entry and message routing in `src/background.ts`
    - Register runtime message handlers mapping `GET_SESSION`/`GET_ROLE`/`GET_FLOW`/`GET_KEYS`/`EXECUTE` to AuthService/ApiClient, and the `TRACK_START`/`TRACK_STOP` Port to the ExecutionTracker
    - _Requirements: 16.1, 16.2, 16.3_

  - [x] 15.2 Wire the content script to the builder flow end-to-end
    - Connect flow loading, BuilderHelpers rendering, the execute button → ExecutionModal → execute → tracking UI, and the CanvasHighlighter driven by streamed step state
    - _Requirements: 1.2, 5.3, 8.5, 11.2, 12.2, 15.1_

  - [x] 15.3 Write integration tests for the end-to-end messaging flows
    - Popup → worker session/role flow; content script → worker flow-load, execute, and tracking Port flows with mocked `chrome.*` and `fetch`
    - _Requirements: 1.4, 5.2, 11.1, 12.1_

- [x] 16. Final checkpoint — full build and test suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references the specific requirement clauses it satisfies for traceability.
- Property tests (Properties 1–24) use `fast-check` + Vitest at a minimum of 100 iterations, one test per property, with the tag `Feature: ipaas-helper-extension, Property {number}: {property_text}`; ApiClient and tracker properties use stubbed `fetch`/cookie reader and fake timers.
- Checkpoints provide incremental validation at natural boundaries.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "6.1", "7.1", "8.1", "10.1", "14.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2", "7.3", "7.4", "8.2", "8.3", "8.4", "10.2", "10.3", "11.1", "14.2", "14.3"] },
    { "id": 5, "tasks": ["6.6", "6.7", "11.2", "11.3"] },
    { "id": 6, "tasks": ["11.4", "12.1"] },
    { "id": 7, "tasks": ["12.2", "12.3", "12.4", "12.5", "12.6", "15.1"] },
    { "id": 8, "tasks": ["15.2"] },
    { "id": 9, "tasks": ["15.3"] }
  ]
}
```
