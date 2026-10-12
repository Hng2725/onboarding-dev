# Changelog

This project follows [Semantic Versioning](https://semver.org/). Each marketplace listing version
must equal `privos-app.json.version` and `package.json.version`; change both release notes and metadata
in one commit.

## [2.17.18] - 2026-10-13

### Security

- `hr_app_db_store`, `hr_app_object_store` and `hr_bulk_export` now refuse a call that carries no verified
  caller identity. The two bot-credential tools take the room from the verified caller; a `roomId`
  argument is optional and is rejected when it names any other room, so a caller in one room can no longer
  read or write another room's app data through the app's own bot credential. The `roomId` input is no
  longer required in the tool schemas. In `npm run dev` (unverified relay pairing) these three tools are
  refused for the same reason.

### Changed

- The manifest the app serves now carries the `ui` declaration (`ui.distDir`) that `privos-app.json` has had since
  2.17.15, so the served manifest and the published one have the same canonical hash.

## [2.17.17] - 2026-09-15

### Changed

- The info panel heading reads "App and room info". A visible UI change, so this version ships a UI
  bundle whose digest differs from 2.17.15/2.17.16 and an upgrade must ingest it before the swap.

## [2.17.16] - 2026-09-15

### Changed

- No functional change. Upgrade target for proving that the Hub ingests and verifies the signed UI
  bundle before switching the served UI, and refuses the swap when the bundle bytes do not match.

## [2.17.15] - 2026-09-15

### Changed

- The manifest declares `ui.distDir: "dist/ui"`, so the published version carries a signed UI bundle
  built from the Vite output and the Hub serves the app UI from tenant storage.

## [2.17.14] - 2026-09-14

### Changed

- No functional change. Upgrade target for proving that a self-hosted upgrade and uninstall leave
  no staged artifacts behind.

## [2.17.13] - 2026-09-14

### Changed

- No functional change. The self-hosted drill host is on 2.17.12 with a runtime pinned to stale
  dispatch claims, so a further version is needed to prove the corrected in-place upgrade.

## [2.17.12] - 2026-09-14

### Changed

- No functional change. The self-hosted drill host picked up 2.17.11 at install time, so a
  further version is needed as the in-place upgrade and rollback target.

## [2.17.11] - 2026-09-14

### Changed

- No functional change. Republished so a self-hosted host on 2.17.10 has a newer marketplace
  version to exercise the in-place upgrade and rollback path of the local execution mode.

## [2.17.10] - 2026-09-13

### Changed

- **Upgrade `@privos_ai/app-server` to `^0.11.1`.** In local execution the SDK now verifies the
  Hub's user token against the Hub JWKS at the attested origin, so `hr_whoami` reports the caller
  as verified. No manifest, scope, or permission change.

## [2.17.9] - 2026-09-13

### Fixed

- **Readiness conformance, corrected.** The Hub compares the manifest's tools against the served
  list after lifting each tool's `_meta.ui` to `ui`, so a manifest `ui` must be served as
  `_meta.ui` (2.17.8 served it at top level, which the Hub ignores). `tools/list` now serves each
  manifest entry with its `ui` under `_meta`; a test applies the Hub's mapping and checks
  canonical equality with the manifest. No permission or scope change.

## [2.17.8] - 2026-09-13

### Fixed

- **Readiness conformance for local and publisher-hosted execution.** The Hub requires the served
  `tools/list` to equal the reviewed manifest's tools byte for byte and `serverInfo.name` to equal
  the manifest name. The server now serves the manifest's tool definitions verbatim (the two
  app-platform demo tools are declared in the manifest instead of being served undeclared) and
  reports `serverInfo.name = ai.privos.mcp-app-demo` with the display title in `serverInfo.title`.
  No permission or scope change.

## [2.17.7] - 2026-09-13

### Changed

- **Republish on `@privos_ai/app-server` 0.11.0** for the SDK's new `runtime-v3` mode: a
  `SELF_HOSTED_LOCAL` container now answers the Hub's signed dispatch and the unsigned
  pre-activation readiness triple through `serveApp` itself, the same way `managed` already does.
  The manifest-only surface for `PRODUCTION_WITHOUT_IDENTITY` stays: the marketplace build node
  still runs the image bare and requires the manifest. No manifest, scope, or permission change.

## [2.17.6] - 2026-09-13

### Changed

- **Republish with no manifest, scope, or behavior change** so the platform publish pipeline
  records a signed local OCI artifact for this listing's `SELF_HOSTED_LOCAL` execution mode.
  Identical permission declaration to 2.17.5; the only new output is the signed local
  distribution artifact an App Cluster downloads and runs.

## [2.17.3] - 2026-09-01

### Changed

- **Republish with no manifest, scope, or behavior change** so tenants stuck on an older installed
  generation surface an "Update available" prompt and can adopt the 2.17.x permission set (including
  `custom-permissions:read`). Identical permission declaration to 2.17.2.

## [2.17.2] - 2026-09-01

### Changed

- **Custom Permissions tab reframed as the per-record authorization pattern.** The tab intro now
  explains, in the UI, that the demo shows how an app builds "who can read / who can edit" on
  isolated-list records via `additionalReaders` (Readable) / `additionalEditors` (Editable) grants,
  and points to the new builder guide `privos-dev-docs/APP_AUTHORIZATION_WITH_ISOLATED_LISTS.md`
  (written as an agent-implementable spec). README section expanded with the READ/WRITE capability
  table. No manifest, scope, or behavior change.

## [2.17.1] - 2026-09-01

### Security

- **Patch the runtime image's OpenSSL (CVE-2026-14456).** The `node:22-alpine` base shipped
  `libcrypto3`/`libssl3` 3.5.7-r0 (HIGH); the runtime stage now runs `apk --no-cache upgrade
  libcrypto3 libssl3` (fixed in 3.5.8-r0) so the built image passes the marketplace image scan.
  No functional change to the app.

## [2.17.0] - 2026-09-01

### Added

- **Custom Permissions demo tab.** A new tab demonstrating the room custom-permission model and the
  isolated-list item access grants (`additionalReaders` / `additionalEditors`): listing a room's
  permission catalog and reading/setting item Readable/Editable grants through the mediated tool
  surface. Declares the `custom-permissions:read` and `custom-permissions:write` scopes.
  - These scopes require a Portal on MCP permission catalog `2026-08-31` or later (the catalog that
    introduced them) — otherwise version creation is rejected with `PROPOSAL_PERMISSION_UNKNOWN`. The
    grant tools resolve on tenants whose Hub carries the matching custom-permission MCP tools.

## [2.16.0] - 2026-08-31

### Changed

- **UI split into a shell + hashed assets, adopting `@privos_ai/app-server`'s `serveBuiltUi`
  helper (`^0.10.0`).** The whole 549 KB single-chunk bundle (`ai.privos.mcp-app-demo` 2.15.1,
  see `tests/fixtures/ui-inline-2.15.1.html` for the exact byte-for-byte inlined page this
  replaces) is no longer inlined into the `ui://…/form.html` resource on every `resources/read`.
  Instead the Hub reads a small shell (< 4 KB: relay opt-in meta + boot watchdog + relative
  `./assets/…` tags) plus the code-split, content-hashed `assets/` files it references, addressed
  over `ui://ai.privos.mcp-app-demo/assets/<file>` and `ui://ai.privos.mcp-app-demo/assets-manifest.json`.
  `resources/read` now refuses any other URI with JSON-RPC `-32602` — before this release it
  echoed the full UI for any requested URI, which is no longer the case.
  - Vite now builds with `base: './'`, a `manualChunks: { vendor: [...] }` split, and
    `build.manifest: true`; heavy panels (AI chat, AI history, agent-set upload, bot workload,
    embeds, storage, and their shared markdown renderer) are `React.lazy`-loaded from
    `src/ui/panels/`, guarded by an error boundary that shows "A new version of this app is
    available — Reload" if a chunk fails to load (a stale generation after an upgrade).
  - The bundled sample agent-set archive is now a hashed `assets/` file
    (`sample-agent-set.tar-<hash>.gz`) instead of a static `public/` copy; `src/ui/public/` is
    gone — every referenced asset must be a hashed file, none may be silently inlined as base64
    (`build.assetsInlineLimit: 0`) or served unhashed.
  - No sourcemaps are built or published (`build.sourcemap: false`); the bundle continues to
    embed no secrets (no `VITE_*` env values).
  - **Requires Hub ≥ tenant.N** — an older Hub has no route to fetch the split-out `assets/`
    files, so the shell's boot watchdog shows "App assets unavailable — Retry" until the tenant
    is upgraded. No manifest or permission change in this release (the publisher permission
    declaration hash is unchanged from 2.15.1); the canonical manifest digest changes only
    because it is keyed by version.

## [2.15.1] - 2026-08-25

### Added

- **Notification tab** using `mcpapp.notifications.create` and the new optional room-scoped
  `notifications:write` permission — one-user bell, native mobile, and Web Push delivery with
  server-enforced room membership. This declares a new permission, so the publisher
  permission-declaration hash changes from 2.15.0; `notifications:write` is in the Portal
  permission catalog `2026-08-25`.

### Changed

- Upgraded `@privos_ai/app-server` to `^0.8.3` (relay user-token verification now
  accepts the publisher manifest name as a user-token audience alongside the Hub
  record id, so `context.actor` resolves on standalone-production installs).

## [2.15.0] - 2026-08-19

### Added

- **Four new demo tabs for the Step-1 generic platform contract** (merged hub `bff01ee8`;
  live only once this room's Hub is on tenant.132+ — see README.md § App Platform demo
  tabs):
  - **Attempt lifecycle** — `agents.sandbox.attempt-observation` (phase / pending-question /
    bounded output / timestamps), real worker `agents.sandbox.attempt-cancel`, and
    caller-stable `operationId` idempotency on `agents.sandbox.generate-async` (same
    request converges on one attempt; a changed request under the same `operationId` fails
    closed). Runs as the current user under the already-approved `sandbox:generate` scope.
  - **Attempt evidence** — `agents.sandbox.attempt-evidence`, reading per-attempt
    LLM/gateway calls (model/provider/effort/turn/correlation). Same `sandbox:generate`
    scope, no new permission.
  - **App Objects (CAS)** — `mcpapp.objects.put`/`.head`/`.get`, storing and reading one
    immutable, room-private, content-addressed object with sha256 digest verification (Hub
    side and, redundantly, client side).
  - **App Database** — `mcpapp.db.registerCollection`/`.create`/`.query`/`.getSchema`
    against a fixed room-scoped demo collection.
  - New optional permissions: `db:read`, `db:write`, `db:schema:read`, `db:schema:write`.
    The App Objects and App Database tabs run through this app's own installation-bot
    credential (`POST /api/v1/mcp-apps.tool-call`), not the current user's session — see
    `app-platform-tool-call.ts`.

## [2.14.4] - 2026-08-19

### Changed

- **Pairing robustness** (`@privos_ai/app-server` ^0.7.3). Two one-command-pairing fixes:
  the identity file now persists the bare Hub `https` origin (not the `wss` relay endpoint),
  so user-token JWKS verification accepts it; and a pre-existing identity file now aborts
  pairing *before* the Hub handshake, so a retry never registers a dead installation. No
  manifest or permission change — the reviewed manifest digest is unchanged from 2.14.3.

## [2.14.3] - 2026-08-19

### Changed

- **One-command pairing** (`@privos_ai/app-server` ^0.7.1). `pnpm pair` now registers, then
  waits — polling the Hub with the same pairing token until an admin approves the permission
  ceiling — and starts the app automatically after approval. No second pairing URL. Nothing
  usable is returned before approval; the out-of-band fingerprint check still applies.

## [2.14.2] - 2026-08-19

2.14.0 and 2.14.1 never published. 2.14.0: the lockfile still resolved
`@privos_ai/app-server` to the vendored dev tarball, which the build node cannot satisfy
(preflight `build_failed`). 2.14.1: the build node probes the bare image for
`/.well-known/mcp/manifest.json`, and serveApp's fail-closed `PRODUCTION_WITHOUT_IDENTITY`
refusal exited the process before anything served it (`runtime_manifest_unavailable`).

### Added (2.14.2)

- **Manifest-only degraded surface.** When production has no runtime identity yet (no
  workload socket, no paired identity file), the app now serves ONLY the public reviewed
  manifest plus `/health`, with `/ready` held at 503 and **no `/mcp` surface** — dispatch
  stays fail-closed, the platform's bare-image manifest probe passes, and a real
  misconfiguration still turns the container unhealthy. `AMBIGUOUS_RUNTIME_IDENTITY`
  remains a hard exit.

### Changed

- **Adopt the `serveApp` unified SDK entrypoint** (`@privos_ai/app-server` ^0.7.0). One
  `serveApp(...)` resolves the runtime mode and wires transport, trust bootstrap, and the
  agent-bot hub internally; the hand-rolled HTTP MCP server and runtime-identity wiring are
  gone. The interactive development Relay pairing loop stays app-local. The reviewed
  marketplace manifest is served byte-for-byte through the `configure` hook, ahead of the
  MCP router, so the digest pin is unchanged by the migration.

### Added

- **Marketplace permission-catalog conformance test** (`tests/permission-catalog.spec.ts`):
  fails locally on an unknown/retired scope or an invalid `context`/`executionContext`,
  instead of surfacing only at Portal submit as `PROPOSAL_PERMISSION_*`.

### Hardened

- `scripts/package-source.sh` now asserts the required root entries (`privos-app.json`,
  `Dockerfile`), rejects `..` traversal and the marketplace skill-pack path, and enforces the
  20,000-entry archive limit.
- Added a `typecheck:strict-unused` gate (unused locals/parameters) and a `verify:fast-pr`
  aggregate; dropped the `.dockerignore` re-include of `.env.example`.

## [2.13.0] - 2026-08-13

### Added

- **Agent sets are first-class in the Skills tab.** The sandbox listing mixes standalone skills
  with agent sets — a set installs as one unit into its own directory and is selected and removed
  as a unit — so the panel shows them apart and saves both selections. Each array is the complete
  desired state *for its own kind*: sending only one leaves the other alone, and sending an empty
  one clears that kind, which for sets removes whole directories.
- **Agent set upload tab**, gated on the new `sandbox:agent-sets:upload` scope. Preview an archive,
  see what it contains, then commit the batch. A sample set is bundled with the app so the flow
  needs no external file.
- Reference material for publishers: the scope widens which paths an app may reach and is not the
  authorisation — the Hub still requires the acting user to be a workspace admin, and records both
  the user and the attested app as provenance. Archives travel base64 in JSON because the Hub
  relays a REST call and never reassembles a multipart body. The commit is all-or-nothing over a
  single-use session, so a failed confirm cannot be retried from its preview.

## [2.12.0] - 2026-08-13

### Added

- **The app re-syncs a rejected sandbox bot key by itself, once.** When a room's sandbox holds a
  bot key the Hub never pushed, every agent call from this app fails and the only way out was for
  the user to notice the Sandbox tab and press Connect. The app now reacts to the Hub's own
  signals — the coded rejection on an attempt, or the freshness flag on the status the Sandbox
  panel already reads — and asks for the one automatic re-sync the Hub allows, then retries the
  call that failed.
- Reference material for publishers: reacting to a coded Hub failure instead of parsing its
  message, and letting the server own how often a repair may run rather than keeping a local
  counter that any remount would forget.
- **Isolated ASSIGNEE tab.** Demonstrates assigning several users at once to an item on an
  isolated list, and names the field type that actually controls who sees the item: `ASSIGNEE`.
  Docs elsewhere referring to `USER_SELECT` or `MEMBER_SELECT` describe field types the Hub does
  not have, which is what made this look unsupported.

### Notes

- No new permission. The automatic re-sync runs under the existing `sandbox:botkey:push` scope,
  is a plain push, and never carries force-overwrite or bootstrap — those keep their manual
  confirmation because they overwrite a workspace.
- After a refusal the app stops asking and points at the manual Connect button; a successful
  manual sync lets automation help again.

## [2.11.0] - 2026-08-12

### Changed

- **The workspace administrator creates the installation agent bot, not the app.** The app no
  longer requests `bot:agent:create` — the scope no longer exists — and the Bot workload and
  Installation agent bot panels no longer offer a Create button or ask for a name and username.
  An app that can mint a workspace identity decides how it appears to the workspace, and the
  administrator who has to issue that identity's credential could not create it, which is what
  made "Issue" answer `BOT_AGENT_NOT_CONFIGURED` with nothing an admin could do about it.
- **The bot's identity is declared in the manifest.** New `agentBot` field (`name`, `slug`): the
  administrator authorizes the bot in Admin > Apps > Settings, they do not name it.

## [2.10.0] - 2026-08-12

### Fixed

- **An admin-approved provider embed now actually renders.** The Embeds panel asked for the
  provider through `useProviderEmbed` (`@privos_ai/app-react` 0.4.0) instead of iframing it
  itself: the app document is sandboxed without `allow-same-origin`, so every iframe it
  creates inherits an opaque origin and YouTube refuses to initialize in it — approval alone
  left an empty box. The host validates the URL's origin against the admin-approved list and
  renders the frame outside this sandbox, over a placeholder the app owns.

### Changed

- The panel keeps a self-framed copy of the same approved provider next to the hosted one, so
  the difference the hoisted path exists for is visible rather than described, and states the
  host's decision (`requesting` / `granted` / `denied` + reason / `unsupported`) in words.
- `@privos_ai/app-react` dev dependency `^0.3.0` → `^0.4.0`.

## [2.9.0] - 2026-08-12

### Changed

- The records table pages and searches server-side through the Hub's
  `items.query` API instead of reading a whole list into the browser. It takes a
  window of twenty rows, fetches the next window by cursor, filters on the
  server, and refreshes incrementally by asking only for what changed since the
  last load and merging by id.
- `lists:query` is declared as an OPTIONAL permission: an installation that has
  not granted it keeps working through the previous route, which now answers
  with at most 500 items — and the table says so rather than showing a silent
  subset.

### Fixed

- `package-lock.json` claimed `2.5.0` while the app declared `2.9.0`, and it
  carried two extraneous `../` links to a locally checked-out React SDK. The
  publication build runs `npm ci` against that file. No resolved dependency
  version changed.

## [2.8.0] - 2026-08-11

### Added

- A "Validate credential" button on the Bot workload tab that proves the
  configured agent bot credential actually works, instead of only explaining
  where it comes from. Backend tool `hr_agent_bot_credential_check` calls the
  Hub's own `GET /api/v1/me` with `PRIVOS_AGENT_BOT_CREDENTIAL` +
  `PRIVOS_AGENT_BOT_USER_ID` as the `x-user-id`/`x-auth-token` header pair
  Hub REST authentication expects, bounded by a 5s timeout. The UI
  distinguishes `not-configured` (either env var absent), `invalid` (Hub
  rejected them — most likely cause named explicitly: an admin re-issued the
  credential and this container still holds the old, dead value until the
  configuration is applied and the container recreated), `hub-unreachable`
  (Hub origin unresolved or the request itself failed/timed out — distinct
  from an explicit rejection), and `valid` (shows the bot's own `_id`/
  `username` as proof). The credential value itself is never returned,
  logged, or thrown.
- Declared the reserved env key `PRIVOS_AGENT_BOT_USER_ID` (not secret),
  paired with the existing `PRIVOS_AGENT_BOT_CREDENTIAL` for Hub REST
  authentication.

## [2.7.0] - 2026-08-11

### Changed

- Removed frontend issuance of the installation agent bot's Hub credential
  from the Bot workload tab: the `mcpapp.bot.issueCredential` call, its
  `BOT_CREDENTIAL_ISSUE_DENIED`/`BOT_CREDENTIAL_ISSUE_DISABLED` error mapping,
  and the `bot:credential:issue` optional permission are all gone. That tool
  and scope are being removed from the Hub catalog — no app calls them any
  more. Issuance now happens only in the Hub's own Admin > Apps > this app >
  Settings, performed manually by a workspace admin; the tab explains this in
  place of the old button.
- Declared the reserved secret env var `PRIVOS_AGENT_BOT_CREDENTIAL`. The
  backend (`mcp-message-handlers.ts`) reports whether it is configured
  (`agentBotCredentialSet`, never the value) alongside the existing SMTP
  secret check, demonstrating the correct consumption side: read from the
  app's own environment, never received from a frontend call.

## [2.6.0] - 2026-08-11

### Added

- A Bot workload demo tab covering the installation agent bot's full
  execution lifecycle: create the bot, join the current Room, issue its Hub
  credential, then pick it (or the Room default bot) as the executor on
  `agents.sandbox.generate-async`, poll the attempt, and see how a raised
  question surfaces as a Room thread message that only a Room OWNER can
  answer — `agents.sandbox.answer` is deliberately not exposed to apps, so
  the panel only ever tells you to go look. The issued credential is never
  rendered, logged, or persisted; the panel explains it belongs in the app
  backend, not a browser.
- An executor selector on the AI Chat tab. It also documents, and lets an
  operator see for themselves, that an installation-owned agent bot can run
  as a Sandbox executor but currently cannot be an AI Chat agent —
  `ai-messages.send` resolves the agent's token from a `BotTokens` row, which
  installation-owned bots don't have.
- Optional approval declarations for `bot:credential:issue` and
  `sandbox:generate`, each with independent degraded behavior.

### Changed

- `restCall` now surfaces the Hub's actual REST failure reason (`body.error`)
  instead of a bare status code, so distinct failure modes — an unprovisioned
  executor bot vs. a task already bound to a different one — are
  distinguishable in the UI.

## [2.5.0] - 2026-08-09

### Added

- An Embeds demo tab showing how the workspace's external-embed allowlist behaves. The app
  declares `https://www.youtube.com` under `tools[].ui.csp['frame-src']`; the tab renders that
  declared provider next to an origin it never declared, and lists whatever the browser refuses,
  so an operator can see that a declaration is a request and the administrator's approval is what
  is enforced.
- An Agent bot demo tab that creates one bot owned by the exact app installation, explicitly joins
  it to the Hub-authorized current Room, and reads only its safe current-Room identity. The Room
  actions expose no Room, bot, token, or secret selector.
- Optional approval declarations for `bot:agent:create`, `bot:room:join`, and
  `bot:identity:read`, each with independent degraded behavior.

## [2.2.0] - 2026-08-05

### Added

- An app-owned AI chat panel. The app tells the Hub it renders its own chat
  window, so the Hub's floating launcher opens this panel instead of the Hub's
  own chat and hides itself while the panel is open; minimizing hands the
  launcher back. Publishers who ship their own chat design can copy
  `src/ui/app-owned-chat-panel.tsx` as the reference implementation.

### Changed

- Both PrivOS SDKs now install from the npm registry (`@privos_ai/app-server`
  ^0.3.1, `@privos_ai/app-react` ^0.3.0) instead of tarballs and a hand-copied
  React SDK under `vendor/`. Publishers cloning this reference no longer inherit
  local-path dependencies that a marketplace submission cannot resolve.

### Requires

- A Hub that answers the `host/chat.register` bridge handshake. On an older Hub
  the panel reports the surface as unsupported and the app falls back to its own
  entry point, so the app stays functional.

## [2.1.1] - 2026-08-04

### Fixed

- The app now pairs when PrivOS runs it as an App Library generation. A node
  running a generation attests the generation rather than a standalone replica,
  and the previous runtime SDK rejected that attestation outright, so `/ready`
  stayed 503 with `BROKER_RESPONSE_INVALID` and every tool call was refused.
- Tool calls the Hub routes through a cluster are now verified against the
  attested generation. That assertion carries generation affinity, which
  neither dispatch verifier in the previous SDK accepted.

### Changed

- Runtime SDK `@privos_ai/app-server` 0.2.1 → 0.3.1.
- A dispatch verified through the cluster reports no actor: the Hub authorizes
  the call without naming the caller, so `whoami` returns no subject there.

## [2.1.0] - 2026-08-04

### Changed

- Declared the schema-v3 lifecycle manifest, including an empty
  `resourceManifestTemplate`: this app is stateless and owns no publisher
  resource outside the platform-managed ones the control plane injects.
- The manifest lint, preflight and runtime readiness checks now accept every
  supported schema version instead of pinning to v2.

### Notes

- The `roomId` argument of `hr_management_dashboard` is a runtime tool
  parameter. Installation stays roomless; a room is chosen later, per room.

## [2.0.0] - 2026-08-02

### Changed

- Replaced browser bearer tokens with capability-aware host calls and a
  secretless workload identity derived from the app-cluster broker.
- Adopted the strict schema-v2 permission contract and private, body-bound MCP
  dispatch protocol. This is intentionally not compatible with v1 runtimes.

### Security

- The production image now carries the canonical reviewed manifest as an OCI
  configuration label; Marketplace release approval remains a detached,
  digest-bound control-plane attestation.

## [1.0.0] - 2026-08-02

### Added

- Deterministic, secret-safe source archive and SHA-256 provenance output.
- Self-contained vendored React SDK for isolated platform builds.
- Direct HTTP and local relay transports over one MCP handler set.
- Non-root, read-only-compatible multi-stage container.
- Canonical root `privos-app.json`, scope justifications and Free/Pro license example.
- Preflight, Vitest coverage, GitHub Actions and hardened container smoke test.
- Publisher walkthrough and complete listing launch kit.
- App-specific Marketplace privacy notice and terms of use.

### Changed

- Repository/package identity is `privos-mcp-app-demo` / `ai.privos.mcp-app-demo` and the app title is
  `PrivOS Demo MCP App`.
- Scope inventory was audited against real REST call sites. All ten scopes remain because every one
  is exercised; no unused scope survived the audit.

### Security

- Credential backups, recycle-bin state, build output and local dependencies are excluded from source
  archives and Docker contexts.
- The production image removes the unused npm/npx package-management toolchain and its transitive
  attack surface after the build stage.
