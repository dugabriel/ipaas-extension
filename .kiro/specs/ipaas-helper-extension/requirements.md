# Requirements Document

## Introduction

This feature is a Chrome browser extension that acts as a helper for the TOTVS iPaaS web application (hosted at https://ipaas.totvs.app/). The Extension assists users in four areas: inspecting the current session (company, user, and effective role), understanding builder flows on-screen (function origins and condition summaries), executing an integration directly from its trigger node, and tracking the resulting execution end-to-end.

The session and builder helpers are read-only: they decode the session token and read flow data to surface information, without changing anything on the iPaaS side. The execution feature is the exception — it performs an authenticated POST that triggers an integration run, but only when the user explicitly initiates it through a confirmation modal. No action is taken against the iPaaS backend without a deliberate user trigger.

All authenticated API calls use the session JWT captured from the browser cookie `jwt.token` (not HttpOnly, readable via `document.cookie`) by the Content_Script running in the iPaaS tab, sent as an `Authorization: Bearer {token}` header, because the cookie alone returns HTTP 401 from the API hosts. The token is captured on demand in the exact tab/profile the user is viewing, so the Extension always acts on the correct company's session even when the user is signed into other TOTVS systems or companies in other tabs. The Extension reads live data (JWT claims, role, flow payload, execution keys, messages, steps) from the confirmed iPaaS endpoints and renders it only within the user's own browser session.

## Glossary

- **Extension**: The Chrome browser extension described by this specification.
- **iPaaS_Site**: The TOTVS iPaaS web application served from the host `ipaas.totvs.app`.
- **Builder_Page**: A page of the iPaaS_Site whose path matches `/builder/{diagramId}`, where the user edits an integration flow.
- **Diagram_Id**: The identifier of the open diagram, taken from the Builder_Page URL path segment.
- **Session_Cookie**: The browser cookie named `jwt.token` set on the iPaaS_Site domain, containing the session JWT.
- **Content_Script**: The Extension script injected into iPaaS_Site pages; it can read `document.cookie` in the tab's exact browser context (normal or Incognito).
- **Captured_Token**: The `jwt.token` value read from an iPaaS_Site tab's `document.cookie` by the Content_Script and stored in `chrome.storage.session`.
- **Capture_Action**: The explicit user action in the Session_Panel ("Capture session") that triggers reading the Captured_Token from the active iPaaS_Site tab.
- **Session_Store**: The `chrome.storage.session` area holding the Captured_Token; it is isolated per browser profile and cleared when the browser session ends.
- **JWT**: A JSON Web Token composed of a header, payload, and signature, encoded as three Base64URL segments separated by dots.
- **JWT_Claim**: A single key-value field contained in the decoded payload of the JWT, including `fullName`, `login`, `email`, `companyId`, `tenantCode`, `tenantIdpId`, `domain`, `env`, `partnerCompany`, `sub`, `userIdpId`, `exp`, and `iat`.
- **JWT_Decoder**: The component of the Extension that decodes the JWT payload into JWT_Claims.
- **Bearer_Header**: The HTTP request header `Authorization: Bearer {token}`, where `{token}` is the Session_Cookie value.
- **Session_Panel**: The user interface shown as the Extension popup (opened from the Extension toolbar action) that displays session and role information.
- **Company**: The iPaaS organization identifier associated with the session, labeled "empresa" in the iPaaS_Site, derived from JWT_Claims.
- **User**: The authenticated user associated with the session, labeled "usuário" in the iPaaS_Site, derived from JWT_Claims.
- **User_Code**: The user identifier used by the roles API, derived from the JWT_Claim `userIdpId` (the IdP user UUID).
- **Tenant_Code**: The tenant identifier used by the roles and keys APIs, derived from the JWT_Claim `tenantIdpId` (the IdP tenant UUID). Note: the `tenantCode` claim is a human-readable slug and is NOT accepted by these APIs.
- **Role**: The authorization profile returned by the Roles_API, including `name`, `type`, `gatewayEnabled`, and a `features` array.
- **Roles_API**: The authenticated endpoint `GET https://api-ipaas.totvs.app/connector-auth/api/v1/roles/by-user-tenant?userCode={User_Code}&tenantCode={Tenant_Code}`.
- **Feature_Permission**: A single entry in the `features` array of the Role response, each with an `id` and a `name`.
- **Integrations_API**: The authenticated endpoint `GET https://api-ipaas.totvs.app/ipaas/api/v3/integrations?diagramId={Diagram_Id}&fieldsReturn=...&pageSize=1`, returning the flow payload.
- **Integration**: The record returned by the Integrations_API, including `id` (the Integration_Id), `name`, `active`, `status`, and `flow`.
- **Integration_Id**: The `id` field of the Integration, used to key execution and tracking calls.
- **Flow**: The `flow` object of the Integration, containing `async`, `functions`, `activities`, `start`, and `globalErrorFlow`.
- **Flow_Function**: An entry in `flow.functions`, with keys `id`, `name`, `type`, `label`, `params`, `componentId`, `componentResourceId`, and `connections`.
- **Flow_Activity**: An entry in `flow.activities`, carrying origin metadata such as `ownerTenantName`, `componentAccountId`, `serviceId`, `isCustom`, and `shared`, and (for conditions) a `configurations` object.
- **Origin_App**: The originating app/component of a Flow_Function, resolved from the function's component identifiers and the related Flow_Activity origin metadata.
- **Condition_Activity**: A Flow_Activity whose type is `CONDITION`, with `configurations.conditionType` and `configurations.conditions[]`, where each condition has `input`, `operation`, and `booleanOperator`.
- **Start_Activity**: The Flow_Activity referenced by `flow.start`.
- **Webhook_Trigger**: A Start_Activity whose type is `WEBHOOK`, in either synchronous or asynchronous mode.
- **Keys_API**: The authenticated endpoint `POST https://api-ipaas.totvs.app/ipaas/api/v4/keys?page=0&pageSize=9999` with body `{}`, returning execution key entries.
- **Execution_Key**: An entry from the Keys_API, including `id`, `integrationId`, `apiKey`, `eai`, `noContent`, `sync`, `diagram{id,name}`, and `project{id,name,type}`.
- **Api_Key**: The `apiKey` (UUID) of the Execution_Key matching the current Integration.
- **Execution_Modal**: The modal interface where the user enters the request payload (body) and HTTP headers before triggering an execution.
- **Trigger_Overlay**: The execute button the Extension overlays on the Builder_Page at the on-screen position of the Start_Activity node (the DOM element whose id equals `flow.start`), kept aligned as the canvas pans/zooms.
- **Tracking_Modal**: The modal the Extension opens on execution to show the overall Message status and the ordered Execution_Steps, with loading indicators until each item reaches a Terminal_State.
- **Execution_History**: A capped list (at most 10) of recent executions the Extension keeps in `chrome.storage.local`, each with the Message_Id, status, timestamp, and the originating Integration name/Diagram_Id.
- **Execute_API**: The authenticated endpoint `POST https://api-ipaas.totvs.app/ipaas/api/v1/integrations/{Integration_Id}/api-key/{Api_Key}`, used to trigger a run.
- **Execution_Response**: The response of the Execute_API when present, with fields `status`, `messageId`, and `timestamp`.
- **Message_Id**: The `messageId` returned by the Execute_API, used to track an execution.
- **Message_Detail_API**: The authenticated endpoint `GET https://api-ipaas.totvs.app/ipaas/api/v4/messages/{Message_Id}`.
- **Message**: The record returned by the Message_Detail_API, including `id`, `integrationId`, `diagramId`, `diagramName`, `status`, `executionTime`, `initialComponent`, `finalComponent`, `sourceType`, `originMessageId`, `totalSplitMessage`, and `message`.
- **Steps_API**: The authenticated endpoint `GET https://api-ipaas.totvs.app/ipaas/api/v3/steps/{Integration_Id}/{createdDate}/{Message_Id}`.
- **Execution_Step**: An entry from the Steps_API, including `messageId`, `componentId`, `activityLabel`, `status`, `startDate`, `endDate`, `inMessage`, `outMessage`, `inHeaders`, `outHeaders`, `functions`, `condition`, and `resourceType`.
- **Child_Messages_API**: The authenticated endpoint `GET https://api-ipaas.totvs.app/ipaas/api/v4/messages?sourceTypes=SPLITTED&originMessageId={Message_Id}&initialDate=...&finalDate=...&status=DONE&status=ERROR&status=REPROCESSED&status=PROCESSING`.
- **Child_Message**: A Message with `sourceType=SPLITTED` whose `originMessageId` points to a parent Message.
- **Terminal_State**: A Message or Execution_Step status of `DONE` or `ERROR`, at which polling for that item stops.
- **Sensitive_Payload**: Business data carried in Message `message` and in Execution_Step `inMessage`, `outMessage`, `inHeaders`, and `outHeaders` fields, which may contain real records, SQL, or network addresses.
- **Expiration_Claim**: The JWT_Claim named `exp` that indicates the token expiration time as a Unix timestamp.

## Requirements

### Requirement 1: Domain and Host Scoping

**User Story:** As an iPaaS user, I want the Extension to act only on the iPaaS site and reach only the required API hosts, so that it does not run on unrelated websites or access unnecessary endpoints.

#### Acceptance Criteria

1. WHILE the active tab displays a page whose host is not `ipaas.totvs.app`, THE Extension SHALL keep the builder helpers inactive and SHALL NOT inject any builder UI into that page.
2. WHEN a page of the iPaaS_Site finishes loading and the page path matches `/builder/{Diagram_Id}`, THE Extension SHALL activate the builder helpers for that page within 2 seconds of load completion.
3. WHILE an iPaaS_Site page path does not match `/builder/{Diagram_Id}`, THE Extension SHALL keep the builder helpers (Requirements 5 through 11) inactive on that page.
4. THE Extension SHALL make the Session_Panel available through the Extension toolbar action on the iPaaS_Site rather than injecting it into every page.
5. THE Extension SHALL request host access limited to `https://ipaas.totvs.app/`, `https://api-ipaas.totvs.app/`, and `https://api-fluig.totvs.app/`, and SHALL NOT request host access to any other host.
6. THE Extension SHALL request the `storage` permission to hold the Captured_Token in the Session_Store, and SHALL NOT require the `cookies` permission, since the session token is read from `document.cookie` by the Content_Script.

### Requirement 2: Capture the Session Token On Demand and Decode the JWT

**User Story:** As an iPaaS user who may be signed into several TOTVS systems and companies across different tabs (including Incognito), I want to explicitly capture the session of the exact iPaaS tab I am looking at, so that the Extension always acts on the correct company's session and never on a sibling system's token.

**Rationale:** The TOTVS identity cookie `jwt.token` is shared across sibling systems on parent domains and is partitioned per browser profile (normal vs. Incognito). Reading it from the service worker via `chrome.cookies` can return another system's or another profile's token. Because `jwt.token` is not HttpOnly, the Content_Script running in the iPaaS tab can read it from `document.cookie` in the exact context the user is viewing, which is the authoritative source.

#### Acceptance Criteria

1. THE Extension SHALL capture the Session_Cookie value (`jwt.token`) only by reading `document.cookie` within an iPaaS_Site tab via the Content_Script, and SHALL NOT read the session token through the `chrome.cookies` API.
2. WHEN the user activates "Capture session" in the Session_Panel, THE Extension SHALL request the `jwt.token` value from the Content_Script of the active iPaaS_Site tab and SHALL store the captured token in `chrome.storage.session`.
3. WHEN the builder helpers activate on a Builder_Page, THE Content_Script SHALL capture the `jwt.token` value from its own `document.cookie` without requiring the user to use the Session_Panel button.
4. THE Extension SHALL use the captured token for every authenticated API call and SHALL hold it only in `chrome.storage.session`, which is isolated per browser profile and cleared when the browser session ends.
5. IF no iPaaS_Site tab is available to capture from, or the captured `jwt.token` is absent or an empty string, THEN THE Session_Panel SHALL display a message stating that no active session was found and prompting the user to open iPaaS and capture again.
6. WHEN a token value is captured, THE JWT_Decoder SHALL decode the JWT payload segment into JWT_Claims within 500 milliseconds, without verifying the cryptographic signature.
7. IF the captured token value does not contain exactly three Base64URL segments separated by two dots, THEN THE JWT_Decoder SHALL classify the token as invalid and THE Session_Panel SHALL display a message indicating a malformed token structure.
8. IF the JWT payload segment cannot be Base64URL-decoded into a syntactically valid JSON object, THEN THE JWT_Decoder SHALL classify the token as invalid and THE Session_Panel SHALL display a message indicating the payload could not be decoded.

### Requirement 3: Session Panel — Display Company, User, and Expiration

**User Story:** As an iPaaS user, I want to see my company, user, and session expiration, so that I can confirm the context I am working in.

#### Acceptance Criteria

1. WHEN the JWT is decoded successfully, THE Session_Panel SHALL display the Company value derived from the JWT_Claims as the human-readable tenant slug (JWT_Claim `domain`, falling back to `tenantCode`) together with the `companyId` identifier.
2. WHEN the JWT is decoded successfully, THE Session_Panel SHALL display the User value derived from the JWT_Claims.
3. WHEN the JWT is decoded successfully, THE Session_Panel SHALL display the environment value derived from the JWT_Claim `env`.
4. IF a JWT_Claim required for the Company, User, or environment value is absent or an empty string, THEN THE Session_Panel SHALL display a not-available indicator for that value while still displaying the other available values.
5. WHEN the JWT is decoded successfully AND the Expiration_Claim is present, THE Session_Panel SHALL display the expiration time derived from the Expiration_Claim as a human-readable local date and time.
6. IF the Expiration_Claim, converted to a point in time, is earlier than the current system time, THEN THE Session_Panel SHALL display an expired-session indicator that is visually distinct from the active-session indicator.
7. IF the Expiration_Claim is absent or is not a valid Unix timestamp integer, THEN THE Session_Panel SHALL display an indicator that expiration status is unavailable while retaining the other decoded values.

### Requirement 4: Session Panel — Resolve and Display the Effective Role

**User Story:** As an iPaaS user, I want to see my real role and effective permissions, so that I know what I am authorized to do, even though the JWT `roles` claim is empty.

#### Acceptance Criteria

1. WHEN the JWT is decoded successfully, THE Extension SHALL derive the User_Code from the JWT_Claim `userIdpId` and the Tenant_Code from the JWT_Claim `tenantIdpId`.
2. WHEN the User_Code and Tenant_Code are derived, THE Extension SHALL call the Roles_API with those values and the Bearer_Header.
3. WHEN the Roles_API returns a successful response, THE Session_Panel SHALL display the Role `name` and the Role `type`.
4. WHEN the Roles_API returns a successful response, THE Session_Panel SHALL display the `name` of each Feature_Permission in the Role `features` array as a list.
5. IF the Roles_API returns an HTTP 401 response, THEN THE Session_Panel SHALL display a message stating that the session is unauthorized or expired and that the user should re-authenticate.
6. IF the Roles_API returns a non-200 response other than 401, or the call fails due to a network error or timeout, THEN THE Session_Panel SHALL display a message that the role could not be retrieved while still displaying the available JWT-derived session data.
7. IF the Roles_API returns an HTTP 404 response, THEN THE Session_Panel SHALL display a message that no role was found for the current user and tenant, while still displaying the available JWT-derived session data.

### Requirement 5: Builder — Load the Flow Payload

**User Story:** As an iPaaS user on the builder, I want the Extension to load the current flow definition, so that the builder helpers have the data they need.

#### Acceptance Criteria

1. WHEN the builder helpers activate on a Builder_Page, THE Extension SHALL read the Diagram_Id from the Builder_Page URL path.
2. WHEN the Diagram_Id is read, THE Extension SHALL call the Integrations_API for that Diagram_Id with the Bearer_Header and SHALL use the first returned item as the Integration.
3. WHEN the Integrations_API returns a successful response containing an Integration, THE Extension SHALL make the Integration `id`, `name`, `active`, `status`, and `flow` available to the builder helpers.
4. IF the Integrations_API returns no items for the Diagram_Id, THEN THE Extension SHALL keep the builder helpers inactive for that page and SHALL display a message that the flow data is unavailable.
5. IF the Integrations_API returns an HTTP 401 response, THEN THE Extension SHALL display a message that the session is unauthorized or expired and that the user should re-authenticate.
6. IF the Integrations_API returns a non-200 response other than 401, or the call fails due to a network error or timeout, THEN THE Extension SHALL display a message that the flow data could not be loaded and SHALL keep the builder helpers inactive for that page.

### Requirement 6: Builder — Show Function Origin App

**User Story:** As an iPaaS user on the builder, I want each function in the "Funções" list to show which app/component it belongs to, so that I know where each function can be used.

#### Acceptance Criteria

1. WHEN the Flow is available on a Builder_Page, THE Extension SHALL resolve the Origin_App for each Flow_Function from the function's `componentId` and `componentResourceId` together with the origin metadata of the related Flow_Activity.
2. WHEN the Origin_App for a Flow_Function is resolved, THE Extension SHALL display the Origin_App alongside that function's name and identifier in the builder UI.
3. IF the Origin_App for a Flow_Function cannot be resolved from the available Flow data, THEN THE Extension SHALL display a not-available indicator for that function's origin while still displaying the resolved origins of the other functions.
4. WHEN the "Funções" list contains multiple Flow_Functions, THE Extension SHALL display an Origin_App indicator for each listed function.

### Requirement 7: Builder — Summarize Conditions

**User Story:** As an iPaaS user on the builder, I want a readable summary of each condition, so that I do not have to open and interpret the condition editor.

#### Acceptance Criteria

1. WHEN the Flow is available on a Builder_Page, THE Extension SHALL render a human-readable summary for each Condition_Activity in the Flow.
2. WHEN rendering a condition summary, THE Extension SHALL include, for each entry in `configurations.conditions[]`, the `input`, the `operation`, and the `booleanOperator` joining it to the next entry.
3. WHEN rendering a condition summary, THE Extension SHALL include the `configurations.conditionType` of the Condition_Activity.
4. IF a Condition_Activity has an empty `configurations.conditions[]` array, THEN THE Extension SHALL display an indicator that the condition has no defined clauses.

### Requirement 8: Builder — Execute Trigger Button and Precondition

**User Story:** As an iPaaS user on the builder, I want an execute button on the trigger node when the flow can be run, so that I can trigger a webhook integration from the canvas.

#### Acceptance Criteria

1. WHEN the Flow is available AND the Start_Activity resolved from `flow.start` is a Webhook_Trigger AND the Integration `active` is true with `status` of `PUBLISHED`, THE Extension SHALL display an execute button on the trigger/start node of the Builder_Page.
2. WHERE the Webhook_Trigger is synchronous and WHERE the Webhook_Trigger is asynchronous, THE Extension SHALL display the execute button in both cases when the preconditions in acceptance criterion 1 are met.
3. IF the Start_Activity is not a Webhook_Trigger, THEN THE Extension SHALL NOT display the execute button.
4. IF the Integration `active` is false OR the Integration `status` is not `PUBLISHED`, THEN THE Extension SHALL NOT display the execute button.
5. WHEN the user clicks the execute button, THE Extension SHALL open the Execution_Modal.

### Requirement 9: Builder — Resolve Execution Key

**User Story:** As an iPaaS user, I want the Extension to find the API key for the current integration, so that it can execute the correct flow.

#### Acceptance Criteria

1. WHEN the Extension needs execution data for the current Integration, THE Extension SHALL call the Keys_API with body `{}` and the Bearer_Header.
2. WHEN the Keys_API returns a successful response, THE Extension SHALL select the Execution_Key whose `integrationId` equals the current Integration `id` or whose `diagram.id` equals the current Diagram_Id, and SHALL use its `apiKey`, `sync`, and `noContent` values.
3. IF no Execution_Key matches the current Integration, THEN THE Extension SHALL display a message that no execution key was found and SHALL disable triggering the execution.
4. IF the Keys_API returns an HTTP 401 response, THEN THE Extension SHALL display a message that the session is unauthorized or expired and that the user should re-authenticate.
5. IF the Keys_API returns a non-200 response other than 401, or the call fails due to a network error or timeout, THEN THE Extension SHALL display a message that the execution key could not be retrieved.

### Requirement 10: Builder — Execution Modal Input Validation

**User Story:** As an iPaaS user, I want to enter a request body and headers before executing, so that I can control the payload sent to the integration.

#### Acceptance Criteria

1. WHEN the Execution_Modal is open, THE Extension SHALL provide one input for the request body as JSON and one input for the HTTP headers.
2. IF the request body input is not valid JSON, THEN THE Extension SHALL display a validation message identifying the body as invalid and SHALL prevent the execution from being sent.
3. IF any HTTP header entry is not a well-formed name-and-value pair, THEN THE Extension SHALL display a validation message identifying the headers as invalid and SHALL prevent the execution from being sent.
4. WHEN both the request body is valid JSON and the HTTP headers are well-formed, THE Extension SHALL enable the user to confirm and send the execution.

### Requirement 11: Builder — Trigger Execution and Capture Message Id

**User Story:** As an iPaaS user, I want to send the execution and get a tracking id, so that I can follow the run.

#### Acceptance Criteria

1. WHEN the user confirms a valid execution in the Execution_Modal, THE Extension SHALL send a POST to the Execute_API for the current Integration_Id and Api_Key, with the user-provided body and headers and the Bearer_Header.
2. WHEN the Execute_API returns a response containing a `messageId`, THE Extension SHALL capture and store the Message_Id for tracking and SHALL display the returned `status` and `timestamp`.
3. IF the Execute_API response contains no `messageId` because the Execution_Key `noContent` is true or the Webhook_Trigger is asynchronous without a return, THEN THE Extension SHALL inform the user that the execution was triggered but no tracking id is available.
4. IF the Execute_API returns an HTTP 401 response, THEN THE Extension SHALL display a message that the session is unauthorized or expired and that the user should re-authenticate.
5. IF the Execute_API returns a non-200 response other than 401, or the call fails due to a network error or timeout, THEN THE Extension SHALL display a message that the execution could not be triggered.

### Requirement 12: Tracking — Poll Message Status

**User Story:** As an iPaaS user, I want the execution progress to update automatically, so that I can see when the run finishes.

#### Acceptance Criteria

1. WHEN a Message_Id has been captured from a successful execution, THE Extension SHALL call the Message_Detail_API for that Message_Id with the Bearer_Header and SHALL repeat the call every 3 seconds.
2. WHEN a Message_Detail_API response is received, THE Extension SHALL display the Message `status`, `executionTime`, `initialComponent`, and `finalComponent`.
3. WHILE the tracked Message and all of its applicable Child_Messages have not reached a Terminal_State, THE Extension SHALL continue polling every 3 seconds.
4. WHEN the tracked Message and all of its applicable Child_Messages have reached a Terminal_State, THE Extension SHALL stop polling.
5. IF a tracking call returns an HTTP 401 response, THEN THE Extension SHALL stop polling and display a message that the session is unauthorized or expired and that the user should re-authenticate.
6. IF a tracking call returns a non-200 response other than 401, or fails due to a network error or timeout, THEN THE Extension SHALL display a message that the tracking update failed and SHALL continue polling at the next interval.
7. WHEN an execution is triggered, THE Extension SHALL open a Tracking_Modal that lists the Execution_Steps and the overall Message status.
8. WHILE the tracked Message has not reached a Terminal_State, THE Tracking_Modal SHALL display a loading indicator for the overall execution and a per-step loading indicator for each Execution_Step whose status is `PROCESSING`.
9. WHEN an Execution_Step reaches a Terminal_State, THE Tracking_Modal SHALL replace that step's loading indicator with its final status (done or error).

### Requirement 13: Tracking — Display Execution Steps

**User Story:** As an iPaaS user, I want to see the ordered executed steps, so that I can trace what the integration did.

#### Acceptance Criteria

1. WHEN tracking a Message, THE Extension SHALL call the Steps_API for the current Integration_Id, the Message created date, and the Message_Id with the Bearer_Header.
2. WHEN the Steps_API returns a successful response, THE Extension SHALL display each Execution_Step in returned order, showing the `activityLabel`, `status`, `startDate`, and `endDate`.
3. WHEN an Execution_Step `status` is `ERROR`, THE Extension SHALL display that step with an error indicator that is visually distinct from `DONE` and `PROCESSING` steps.
4. IF the Steps_API returns a non-200 response, or the call fails due to a network error or timeout, THEN THE Extension SHALL display a message that the steps could not be loaded while retaining the Message status display.
5. WHEN the user expands an Execution_Step in the Tracking_Modal, THE Extension SHALL display that step's `inMessage`, `outMessage`, `inHeaders`, and `outHeaders` as formatted, readable content.
6. WHEN displaying Execution_Step headers, THE Extension SHALL mask any `Authorization`/Bearer token value so no session token is shown, consistent with Sensitive_Payload handling (Req 17).

### Requirement 14: Tracking — Splitter Child Message Aggregation

**User Story:** As an iPaaS user, I want child messages from a splitter aggregated, so that I can see overall progress across all split branches.

#### Acceptance Criteria

1. WHEN a tracked Message has `totalSplitMessage` greater than 0, THE Extension SHALL call the Child_Messages_API with the tracked Message_Id as `originMessageId` and the Bearer_Header.
2. WHEN the Child_Messages_API returns a successful response, THE Extension SHALL display an aggregate count of Child_Message statuses summarizing how many are `DONE`, how many are `ERROR`, and how many are `PROCESSING`, against the `totalSplitMessage`.
3. WHILE any Child_Message has not reached a Terminal_State, THE Extension SHALL continue polling the Child_Messages_API every 3 seconds.
4. WHEN all Child_Messages have reached a Terminal_State, THE Extension SHALL stop polling the Child_Messages_API and SHALL display the final aggregate status.
5. IF the Child_Messages_API returns a non-200 response, or the call fails due to a network error or timeout, THEN THE Extension SHALL display a message that the child message update failed and SHALL continue polling at the next interval.

### Requirement 15: Tracking — Highlight Executed Path on Canvas (Desirable)

**User Story:** As an iPaaS user, I want the executed path highlighted on the builder canvas as the run progresses, so that I can see visually where the execution is.

#### Acceptance Criteria

1. WHERE node elements on the Builder_Page canvas can be reliably located by the `componentId` of each Execution_Step, THE Extension SHALL highlight each corresponding node according to that step's `status`.
2. WHEN an Execution_Step reaches a Terminal_State, THE Extension SHALL update the highlight of the corresponding node to reflect the terminal `status`.
3. IF a node element for an Execution_Step `componentId` cannot be located on the canvas, THEN THE Extension SHALL continue the textual tracking display (Requirements 12 through 14) without the canvas highlight for that step.

> Note: This requirement is desirable and dependent on reliably locating node elements on the builder canvas. The exact highlight mechanism is to be finalized in design and validated during implementation.

### Requirement 16: Authentication for API Calls

**User Story:** As an iPaaS user, I want all API calls to be properly authenticated, so that the Extension can retrieve my data and I am told clearly when my session expires.

#### Acceptance Criteria

1. WHEN the Extension calls the Roles_API, Integrations_API, Keys_API, Execute_API, Message_Detail_API, Steps_API, or Child_Messages_API, THE Extension SHALL include the Bearer_Header built from the Captured_Token held in the Session_Store.
2. IF any authenticated API call returns an HTTP 401 response, THEN THE Extension SHALL re-capture the Captured_Token from the originating iPaaS_Site tab once and retry the call; IF the retried call also returns 401, THEN THE Extension SHALL display a message that the session is unauthorized or expired and that the user should capture the session again.
3. IF no Captured_Token is present in the Session_Store at the time an authenticated API call is required, THEN THE Extension SHALL NOT send the call and SHALL display a message that no active session was found and that the user should capture the session.
4. WHEN the user changes company in iPaaS (which replaces `jwt.token`), THE Extension SHALL use the newly Captured_Token on the next capture or on the next 401-triggered re-capture, so that it never acts on a stale company session.

### Requirement 17: Sensitive Data Handling

**User Story:** As an iPaaS user, I want business data kept within my session, so that confidential records are not exposed to third parties.

#### Acceptance Criteria

1. WHEN the Extension displays a Sensitive_Payload, THE Extension SHALL render it only within the user's own session UI in the browser.
2. THE Extension SHALL send Sensitive_Payloads only to the iPaaS API hosts `api-ipaas.totvs.app` and `api-fluig.totvs.app` as part of the authenticated calls defined in this specification.
3. THE Extension SHALL NOT transmit any Sensitive_Payload, Session_Cookie value, or JWT_Claim to any host other than the iPaaS_Site and the API hosts named in Requirement 1.

### Requirement 18: Graceful Error Handling for API Calls

**User Story:** As an iPaaS user, I want failures to produce clear messages, so that I understand what went wrong instead of seeing a silent or broken UI.

#### Acceptance Criteria

1. IF any authenticated API call fails due to a network error, THEN THE Extension SHALL display a user-visible message naming the failed operation and SHALL leave previously displayed data unchanged.
2. IF any authenticated API call does not complete within 30 seconds, THEN THE Extension SHALL treat the call as timed out and SHALL display a user-visible timeout message for that operation.
3. IF any authenticated API call returns a non-200 response that is not specifically handled elsewhere in this specification, THEN THE Extension SHALL display a user-visible message indicating the operation failed with the returned status.


### Requirement 19: Execution History

**User Story:** As an iPaaS user, I want a short history of my recent executions, so that I can revisit a run and open its message without re-running it.

#### Acceptance Criteria

1. WHEN an execution is triggered and a Message_Id is captured, THE Extension SHALL record an Execution_History entry with the Message_Id, the status, the timestamp, and the originating Integration name and Diagram_Id in `chrome.storage.local`.
2. THE Extension SHALL retain at most 10 Execution_History entries, discarding the oldest when the limit is exceeded.
3. WHEN the user opens the Session_Panel, THE Extension SHALL display the Execution_History entries, most recent first.
4. WHEN the user activates an Execution_History entry, THE Extension SHALL open `https://ipaas.totvs.app/message/{Message_Id}` in a new browser tab.
5. WHILE there are no Execution_History entries, THE Session_Panel SHALL display an indicator that there are no recent executions.
