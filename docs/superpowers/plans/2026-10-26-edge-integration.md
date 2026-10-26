# Edge Integration Implementation Plan

> **For agentic workers:** Execute the approved design task by task with subagent-driven-development and test-driven-development. Preserve all unrelated working-tree changes. Do not restart the live session server or operate Edge for acceptance testing.

**Goal:** Allow an OpenSpecBoard Codex work to operate a user-connected Edge tab through a dedicated extension.

**Architecture:** The session server owns an authenticated loopback HTTP bridge with one-time pairing codes. An MV3 extension long-polls for commands and uses activeTab/scripting to inspect and operate the selected tab. New Codex threads register an `edge_browser` dynamic tool; existing threads remain intact and show an explicit compatibility limitation.

**Tech Stack:** NestJS, Node HTTP/crypto, React/TypeScript, Edge Manifest V3, Vitest and node:test. No browser MCP, remote debugging, or extra production dependencies.

## Shared protocol

- App: `GET /api/browser/edge/status` returns `{extensionPath,connections}`. `GET /api/work/:id/browser/edge` returns `{supported,connected,title?,url?,reason?}`. `POST /api/work/:id/browser/edge/pair` returns `{endpoint,code,expiresAt}`. `DELETE /api/work/:id/browser/edge` revokes the connection.
- Extension: `POST <endpoint>/pair` body `{code,tabId,url,title}` returns `{token,workId}`. `GET /commands` with `Authorization: Bearer <token>` long-polls and returns `{command:null}` or `{command:{id,op,args,tabId,expectedUrl,expiresAt}}`. `GET /commands/:id` checks the delivered command is still valid immediately before browser execution. `POST /results` with the same authorization submits `{id,ok,result?,error?}`. `DELETE /connection` revokes its connection.
- Operations: `observe`, `click`, `fill`, `scroll`, `capture`. Action arguments carry `observationId`, `elementId` for click/fill, `text` for fill, `direction:up|down` and `pixels` for scroll. Observe returns `{observationId,url,title,text,elements:[{id,role,label}]}`. Capture returns `{image:<PNG data URL>,url}`. Success from actions includes `{url}`; actions invalidate the observation in the extension.
- Codes expire after 120 seconds. Commands time out after 20 seconds and are never replayed. One connection per work and one outstanding command per connection. Idle extension connections expire after 60 seconds without authenticated polling. Bridge receives only bounded JSON and validates extension Origin when present. Page origins are rejected. Only http/https tabs are supported.

## Task 1: Local bridge and API

Files: `backend/src/browser/edge-bridge.ts`, `edge.service.ts`, `edge.controller.ts`; `backend/test/edge-browser.test.ts`; register providers/controllers in `backend/src/app.ts`.

- [x] Add failing tests for pairing, expiry, unauthorized clients, selected-work isolation, command roundtrip, timeout, revoke, stale result, origin changes, and API capabilities.
- [x] Run `./scripts/npm.ps1 run test:run --workspace backend -- test/edge-browser.test.ts` and confirm missing implementation fails.
- [x] Implement `EdgeBridge` with lazy loopback listen on port 0 and per-connection pending command ownership. Implement API endpoints with work lookup and legacy-thread capability checks.
- [x] Re-run tests and backend build.

## Task 2: Edge extension

Files: `edge-extension/manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`, `test/*.test.cjs`, `README.md`.

- [x] Test the DOM operation contract with synthetic DOM and test browser transport with mock chrome/fetch APIs before implementation.
- [x] Implement popup pairing from an explicit user click and selected active tab; background long-poll plus runtime recovery; stale observation and page-origin checks; no password/file fields or arbitrary code.
- [x] Invalidate commands across extension restart instead of replaying uncertain inputs. Capture only when the bound tab is active in the focused window.
- [x] Run `./scripts/node.ps1 --test edge-extension/test/*.test.cjs`. Do not install the extension or automate Edge acceptance.

## Task 3: Codex tool

Files: `backend/src/browser/edge-tools.ts`; `backend/src/codex/codex.service.ts`, `backend/src/work/store.ts`; `backend/test/edge-codex.test.ts`.

- [x] Test new-thread tool registration, same-work routing, errors, image content results and compatibility limits for existing threads.
- [x] Register tool at `thread/start`, save a capability version with the work, and handle tool calls separately from ask_user questions. Supply concise operating instructions in the tool description.
- [x] Preserve existing thread IDs. Existing threads without the capability marker display unsupported rather than silently creating a new conversation.
- [x] Run focused Codex/bridge tests and existing codex-work tests.

## Task 4: Connection UI and packaging

Files: `frontend/src/components/EdgeConnection.tsx`, `EdgeConnection.test.tsx`, `SettingsModal.tsx`, `WorkRoom.tsx`, `frontend/src/i18n/edgeMessages.ts`, `messages.ts`; `scripts/desktop-stage.cjs`; `docs/EDGE.md`.

- [x] Test connection status, code issuance, legacy conversation limitation and disconnect; verify code expiry in bridge/extension tests. Use normal API error reporting.
- [x] Add an expandable work panel and installation information in settings. Show only observed connection success, and never clear an unsent work message.
- [x] Bundle `edge-extension` in the desktop service and resolve the installed extension folder without exposing unrelated paths.
- [x] Run UI tests, both builds, extension tests and backend regressions. Provide the user a manual Edge checklist and startup/restart requirements.

## Review and delivery

- [x] Review against the approved design and protocol; fix correctness/security gaps before delivery.
- [x] Record fresh automated verification results and actual Edge acceptance as pending user action.
- [x] Keep the live session server and existing work running; do not auto-install or publish.
