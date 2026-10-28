# Roomfiles Layout and Upload Fix Implementation Plan

**Goal:** Make source uploads reliable and keep Onboarding files in an idempotent English-named Roomfiles hierarchy.

**Design:** A UI-side Roomfiles helper uses the authenticated `McpApp.rest` bridge to find or create `Onboarding-app`, `Uploaded documents`, and `Created templates`. Upload flows always await this helper and pass the correct child `folderId`. Source ingestion uses the canonical metadata returned by Roomfiles, and publishing an AI template uploads a JSON snapshot to the template folder.

## Tasks

1. Add `tests/onboarding-roomfiles.spec.ts` covering exact-name folder reuse, missing-folder creation, race recovery, canonical upload metadata, and template JSON naming/serialization.
2. Add `src/ui/onboarding/roomfiles.ts` with parsers and idempotent folder initialization, cached per app/room.
3. Initialize folders after successful Admin bootstrap without blocking the whole app when Roomfiles is temporarily unavailable.
4. Route AI source uploads and manual template-resource uploads into `Uploaded documents`, using the server-returned name, MIME type, size, and ID for ingestion.
5. After successful AI-template publication, upload a JSON snapshot into `Created templates`.
6. Run the focused test, full typecheck/test/build, build Docker, reload Chrome, and verify the real upload flow.

## Verification

- `npx vitest run tests/onboarding-roomfiles.spec.ts tests/onboarding-ai-admin-ui.spec.ts tests/onboarding-admin-ui.spec.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- Docker rebuild/restart, Chrome reload, and manual Roomfiles/upload/publish smoke test.
