# PrivOS Demo MCP App

This is the reference schema-v2 PrivOS MCP app. It demonstrates exact required and optional
permissions, safe feature degradation, secretless workload identity, authenticated private Hub
dispatch, the iframe host bridge, license-aware behavior, and reproducible Marketplace packaging.

## Runtime trust model

`@privos_ai/app-server`'s `resolveRuntimeMode()` picks exactly one of three modes, in this
precedence, and never guesses:

1. **`managed`** — a workload identity socket is present (App Cluster mounts one per
   installation). No pair URL, OAuth client secret, or browser user token is ever used.
2. **`standalone-production`** — a paired standalone identity file is present (see
   [Standalone production](#standalone-production-self-hosted-against-a-standalone-hub) below).
3. **`development`** — neither is present, and `NODE_ENV` is not `production`.

Both a workload socket and a paired identity file present is a fatal startup error (stale state
from a prior deployment mode, or a misconfigured host — never silently picked). `NODE_ENV=production`
with neither is also a fatal startup error: there is no unsigned-production fallback in any mode.

In `managed` mode, App Cluster mounts a per-installation Unix socket. `@privos_ai/app-server`
creates an ephemeral P-256 DPoP key in memory, obtains short-lived sender-constrained workload
tokens through the socket, and refreshes them without writing credentials to disk or environment
variables. Hub-to-app `/mcp` requests travel through private Cluster dispatch and carry a
short-lived signed assertion bound to the request body, installation, replica, receipt hash, and
permission epoch. The backend actor for `hr_whoami` comes from that verified assertion. The iframe
receives only non-secret host context and uses `app.rest()`, `app.uploadFile()`, and MCP tools
through the Hub bridge as the current user.

Production accepts these non-secret values from the platform:

- `PRIVOS_HUB_ORIGIN`
- `PRIVOS_APP_ID`
- `PRIVOS_INSTALLATION_ID`
- `PRIVOS_WORKLOAD_SOCKET` (normally `/run/privos/identity.sock`)

## Local development

Requirements: Node.js 22+, npm, Git, and Docker.

```bash
git clone https://github.com/PrivOS-AI/privos-mcp-app-demo
cd privos-mcp-app-demo
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` resolves to `development` mode (no workload socket, no paired identity file) and
connects over the Relay WebSocket. Obtain a pairing URL from PrivOS Admin and paste it into the
prompt; credentials are cached to `.env` for the next run. This relaxed-compatibility path — an
unverified `hr_whoami` actor, credentials cached to disk — is only ever reachable when
`NODE_ENV` is not `production`; the SDK's mode resolver refuses `development` outright otherwise.

The Vite UI defaults to `http://localhost:5179`. `DEV_TUNNEL=cloudflared` is optional when the
browser displaying Hub is on another machine.

## Managed direct runtime

The Marketplace image starts Direct HTTP transport by default (`managed` mode once the platform
mounts `PRIVOS_WORKLOAD_SOCKET`; falls back to `development` mode locally when it isn't mounted):

```bash
npm run build
PORT=3000 npm start
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
curl http://127.0.0.1:3000/.well-known/mcp/manifest.json
```

Development compatibility reports manifest-verified readiness without a broker. In production,
`/health` only proves the process is alive; `/ready` returns 200 only after the manifest is valid,
workload identity is paired, and the current receipt/epoch is active. A public or unsigned
production `POST /mcp` returns 403.

## Standalone production (self-hosted against a standalone hub)

A publisher can also run this exact app against a portal-less, self-hosted Hub — same manifest,
same tools, same permission contract as a Marketplace install, but the app pairs directly with the
Hub over the Relay WebSocket instead of App Cluster mounting a socket. Direct HTTP `/mcp` has no
trust source in this mode and always returns 403 (`DISPATCH_ASSERTION_INVALID`); every MCP
dispatch rides the Relay connection with a mandatory Hub-signed assertion.

### Pair

```bash
npm run pair     # or: pnpm pair
```

The command asks for the one-time pairing URL the Hub operator gives you — it takes no arguments,
so the URL never lands in your shell history. It then announces `privos-app.json` over the pairing
socket, which means no admin ever handles the manifest file: the app states what it wants, and an
admin decides what it gets.

One run does the whole flow (`pairAndAwaitApproval`, see `scripts/pair.ts`):

1. It REGISTERS the app. The Hub stores the announced contract and grants nothing. The command
   prints the Hub fingerprint (below) and keeps waiting.
2. An admin approves the declared permissions in Hub Admin > Apps. The command polls with the same
   pairing URL, so there is no second URL and no second run. (By default it gives up after 30
   minutes.)
3. On approval the Hub hands back its dispatch trust, the identity file is written, and **the app
   starts automatically** — `pair` continues into `start` with `NODE_ENV=production` (what
   `start:standalone` runs) through whichever package manager you invoked it with, so there is no
   second command to remember.

The identity file lands at `./privos-standalone-identity.json` (override with
`PRIVOS_STANDALONE_IDENTITY_FILE`) at mode `0600`. While approval is pending, a separate owner-only
`./privos-standalone-identity.pending.json` holds the registration and carries no dispatch trust.
The Hub's fingerprint is printed at registration and again when the identity file is written:

```
PrivOS Hub fingerprint: SHA256:<43-char base64url> — verify this out-of-band before trusting dispatch from this Hub.
```

**Verify this fingerprint out-of-band** — over a channel other than the one that gave you the
pairing URL (a phone call, a separately-verified chat, the operator's own documentation). The
fingerprint is the same SSH-host-key-style trust-on-first-use model as `ssh` printing a host key:
a compromised pairing URL could otherwise hand you a Hub that signs dispatch you'd wrongly trust.
Because `pair` starts the app for itself once approved, compare the fingerprint the moment it is
printed, before the admin approves, and stop the process if it does not match.

### Identity file handling

The identity file is the sole source of Relay OAuth credentials and Hub dispatch trust for this
mode — treat it like an SSH private key:

- Back it up. Losing it means re-pairing (a new pairing URL from the Hub operator); there is no
  recovery path from the file alone.
- Never commit it, `docker cp` it into an image, or log its contents. `scripts/package-source.sh`
  already refuses to package any `.env*` / credential-like file; keep this file out of the
  Marketplace source archive the same way.
- A re-pair attempt over an existing file refuses (`IDENTITY_FILE_ALREADY_EXISTS`) rather than
  silently overwriting it — remove the file first if you intend to re-pair from scratch.

### Run

The `pair` run already started the app. Every later start — after a reboot, a redeploy, or
any ordinary restart — uses the identity file that pairing wrote, and needs no pairing URL:

```bash
npm run start:standalone
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/ready` reports `not_ready` (503) with a specific `reason` — `IDENTITY_NOT_LOADED`,
`RELAY_NOT_AUTHENTICATED`, `MANIFEST_LINT_INVALID`, or `MANIFEST_DRIFT` — until the identity
loads, the Relay connection authenticates, and the locally-built manifest's canonical digest still
matches the digest pinned at pairing time.

### Verified caller identity over Relay

The Relay runtime-dispatch assertion (`SELF_HOSTED_LOCAL` / `PUBLISHER_HOSTED`) proves *which
installation* dispatched a call, but — unlike the managed Cluster assertion — carries no embedded
actor claim. `connectRelay` independently verifies a SEPARATE Hub-signed RS256 user token
(`_meta.privosUser.userToken`) against the Hub's published JWKS
(`/.well-known/mcp-apps/jwks.json`) and cross-binds its room claim to the already-verified dispatch
`roomId`. This is wired in automatically (`hubUserTokenAuth: 'auto'`, the default) whenever a Hub
dispatch trust is configured — true here, since `start:standalone` pins the paired identity's
trust — so `hr_whoami` reports a verified actor for `standalone-production` exactly like it does
for `managed`, with `provenance: 'user-token'` distinguishing it from the managed path's
`'dispatch-assertion'`.

This verification requires the app host to reach the Hub's JWKS endpoint over the network. A
fetch failure or timeout degrades that request's actor to unavailable (`hr_whoami` reports
`verified: false`) — it never crashes dispatch and never falls back to the plain, unverified
`_meta.privosUser.userId` / `username` fields that ride alongside the token.

`npm run dev` / `npm run start:relay` (`development` mode) intentionally configure no Hub dispatch
trust at all (see [Local development](#local-development) above), so this auto-wiring does not
apply there and `hr_whoami` stays unverified for every relay-transported call in that mode — by
design, not a gap.

### Rotation

The Hub can push secret rotation, trust rotation (re-key or a generation/manifest update), and
capability changes over the same authenticated Relay connection, each as an ES256-signed control
notification verified against the identity file's *currently* pinned Hub key before it is applied.
No operator action is required; the identity file is rewritten atomically (temp file + rename) in
place.

### Upgrade path (manifest changes)

`/ready` returns `MANIFEST_DRIFT` when the locally-built `privos-app.json` no longer matches the
canonical manifest digest pinned at pairing — this is the standalone analogue of the managed
image-label digest check. A manifest change (new tool, new permission, new env declaration) needs
re-approval: the Hub operator re-reviews the new manifest and pushes a trust rotation carrying the
new digest before `/ready` goes green again. There is no way to silently start serving traffic
under a manifest the Hub never approved.

The operator's side of that re-approval is Hub Admin → Apps → this app → Settings → **Refresh**
(see the Hub's "Install and operate your own MCP app" doc). Re-pairing this app while it is live is
refused and points back to Refresh — it is never needed for a manifest change.

Every signed exchange in this mode — dispatch assertions and control notifications alike — is
capped at a 30-second signature lifetime with zero verifier headroom (`exp - iat <= 30`, hard
capped even if the Hub asked for more). NTP-synchronized clocks on both the Hub and this app are a
hard requirement, not an optimization; `/ready`'s `RELAY_NOT_AUTHENTICATED` reason is the
observable symptom of clock skew large enough to fail verification.

## Permission contract

[`privos-app.json`](privos-app.json) is the canonical reviewed manifest. Each permission declares:

- required or optional;
- workspace/room context and user/background execution context;
- a stable feature identifier and publisher reason;
- deterministic degraded behavior for every optional permission.

Required permissions are locked during approval. Optional permissions start from the exact
approved subset and may be disabled later; Hub enforces the new epoch immediately. UI capability
checks only hide or explain features and are never the authorization boundary. See
[`SCOPES.md`](SCOPES.md) for the declaration-to-call-site map.

Run the shared linter to print the deterministic canonical manifest and publisher permission hashes:

```bash
npm run manifest:lint
```

Portal and Hub add the versioned authoritative permission catalog, data policy, and immutable image
digest when computing the final permission-contract hash.

## Installation-owned agent bot demo

The **Agent bot** tab demonstrates the split approval model for an app-owned execution identity:
workspace approval creates one bot for the exact parent installation, while separate Room approvals
allow joining that bot and reading its safe identity in the current Room. The Room actions accept no
Room, bot, or token selector; the Hub derives authority from the verified invocation and active Room
binding. Bot-key provisioning remains a separate Sandbox operation.

See [`src/ui/agent-bot-panel.tsx`](src/ui/agent-bot-panel.tsx) for the three tool calls,
[`privos-app.json`](privos-app.json) for their permission declarations, and
[`SCOPES.md`](SCOPES.md) for the approval rationale and degraded behavior.

## Isolated list, multi-user assignment demo

The **Isolated ASSIGNEE** tab demonstrates assigning several users at once to an item on an
isolated list. The field type that controls who can see an item is **`ASSIGNEE`**
(`apps/meteor/server/core-typings/IList.ts` in the Hub) — some older docs name `USER_SELECT` or
`MEMBER_SELECT` instead, but neither field type exists in the Hub; using either name will not
create a working assignment field. One `ASSIGNEE` field accepts a bare user-id string, a `{ _id }`
object, or an **array** of either, so a single field can hold several assignees
(`getAssignedUserIds`, `apps/meteor/app/api/server/lib/isolated-list-item-filter.ts:23-41`).

For an isolated list, the Hub shows an item only to the room owner/admin, the item's creator, and
whoever is listed in its `ASSIGNEE` field(s) (same file, the visibility check that consumes
`getAssignedUserIds`) — nobody else in the room. The demo runs, in order: `mcpapp.lists.create`
(`isolatedList: true`, caller must be room owner/admin) → `mcpapp.lists.addField` (type
`ASSIGNEE`) → `mcpapp.lists.createItem` → `mcpapp.lists.updateCustomField` (writes an array of
user ids) → `mcpapp.lists.getItems` (reads the item back and confirms every assigned id was
stored, not just the first one). See [`src/ui/assignee-demo-panel.tsx`](src/ui/assignee-demo-panel.tsx)
for the calls and [`src/ui/assignee-demo-helpers.ts`](src/ui/assignee-demo-helpers.ts) for the
pure id-list parsing tested in [`tests/assignee-demo-helpers.spec.ts`](tests/assignee-demo-helpers.spec.ts).

Scope: only the already-declared `lists:write` (optional, room owner/admin for the isolated-list
create step) and `lists:read` (required) — no new permission is requested.

**Argument shapes — checked against the Hub's own tool schemas** in
`apps/meteor/server/services/mcp-tool-handlers-lists.ts`:

| Tool | Arguments |
|------|-----------|
| `mcpapp.lists.create` | `roomId`, `name`, `key?`, `description?`, `isolatedList?`, `fieldDefinitions[]`, `stages[]` |
| `mcpapp.lists.addField` | `listId`, `name`, `type`, `fieldId?` |
| `mcpapp.lists.createItem` | `listId`, **`title`** (not `name`), `description?`, `customFields[]`, `stageId?` |
| `mcpapp.lists.updateCustomField` | `itemId`, `fieldId`, `value` |
| `mcpapp.lists.getItems` | `listId`, `offset?`, `count?`, `sortBy?`, `sortOrder?`, `stageId?`, `customFieldFilters[]?` |

The shapes come from the schema definitions; the end-to-end flow itself has **not** been run
against a live Hub (this sandbox has none), so treat the response shapes — as opposed to the
request shapes — as the part still worth confirming on a real installation.

**Verify isolation with two accounts** (manual, needs a real Hub installation):

1. As account A (room owner/admin), open this app in a Room and run the demo on the **Isolated
   ASSIGNEE** tab, entering account A's and account B's user ids (each account's id is shown on
   its own **Identity** tab).
2. As account B, open the same list. The item should be visible — B is an assignee.
3. As account C, a third room member who is not the room owner/admin, not the item's creator, and
   not listed in the ASSIGNEE field, open the same list. The item should **not** be visible.
4. Re-run `mcpapp.lists.updateCustomField` to remove C from nobody's assignment (or add C), and
   confirm C's visibility flips accordingly — this is what proves the ASSIGNEE field, not room
   membership, gates isolated-list item visibility.

### Custom permissions tab — per-record authorization for your app's data

This tab is the worked example of a reusable pattern: **give your app a per-record "who can read /
who can edit" model without writing a permission engine.** Store your records on an **isolated list**
(so they are private by default), then attach **role grants** to individual records with the
`additionalReaders` (Readable) / `additionalEditors` (Editable) fields. The Hub computes the row-level
ACL at every read/write:

| Capability | Who gets it |
|---|---|
| **READ** a record | creator ∪ assignee ∪ room owner/admin ∪ holder of any permission id in `additionalReaders` **or** `additionalEditors` (read cascades to sub-items) |
| **WRITE** a record (edit/move/delete) | creator ∪ assignee ∪ room owner/admin ∪ holder of any permission id in `additionalEditors` (write does **not** cascade) |

A "role" is a **room custom permission** (a named label an owner/admin assigns to human members).
Grant a record to a role by putting the permission id into the record's Readable/Editable list; every
holder then gains access, and revoking the permission removes it immediately. On a non-isolated list
these fields are inert. Full builder guide — written as an implementable spec you can hand to a
coding agent (AI-agent callout, MUST/MUST NOT rules, exact tool argument tables, an implementation
checklist, and verification):
[`privos-dev-docs/APP_AUTHORIZATION_WITH_ISOLATED_LISTS.md`](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/APP_AUTHORIZATION_WITH_ISOLATED_LISTS.md).

The tab walks the full loop — an owner/admin defines a named permission and assigns it to members,
then grants an isolated-list item's `additionalReaders` / `additionalEditors` to that permission so its
holders can read (or read+edit) the item without being its creator or assignee. Flow:

1. **Setup** (current-user REST, owner/admin — no app scope): `POST rooms.customPermissions.create`
   then `POST rooms.customPermissions.assign`.
2. **Read** (`custom-permissions:read`): `mcpapp.rooms.customPermissions.list` +
   `mcpapp.rooms.customPermissions.members`.
3. **Grant** (`custom-permissions:write`): create an isolated list + item, then
   `mcpapp.rooms.customPermissions.setItemAccess` with the permission id in `additionalReaders`
   (read-only) or `additionalEditors` (read+edit).

`setItemAccess` still requires the acting user to be room owner/admin and every id to exist in the
room catalog — the Hub enforces both regardless of the granted scope. Minting/assigning permissions
is deliberately NOT an app-scoped operation; it stays a human owner/admin action via REST. See
[`src/ui/custom-permissions-panel.tsx`](src/ui/custom-permissions-panel.tsx) and the pure grant-patch
helpers in [`src/ui/custom-permissions-helpers.ts`](src/ui/custom-permissions-helpers.ts)
(tested in [`tests/custom-permissions-helpers.spec.ts`](tests/custom-permissions-helpers.spec.ts)).

| Tool | Arguments |
|------|-----------|
| `mcpapp.rooms.customPermissions.list` | `roomId?` (defaults to approved room) |
| `mcpapp.rooms.customPermissions.members` | `roomId?`, `permissionId` |
| `mcpapp.rooms.customPermissions.setItemAccess` | `itemId`, `additionalReaders?`, `additionalEditors?` |

## App Platform demo tabs (Step-1 generic platform contract)

### Notification tab

The **Notification** tab demonstrates the room-scoped `mcpapp.notifications.create` built-in Hub tool. Enter a user ID belonging to the current room, a title, and a message, then select **Send notification**. The tool requires optional `notifications:write` consent; the Hub—not the app—selects the authorized room and rejects inactive users or users outside that room. A successful call creates the notification bell record and triggers native mobile and Web Push delivery on a best-effort basis.

Four tabs demonstrate capabilities that landed in the merged hub `bff01ee8` (Step-1 generic
platform contract). **They are code-ready but exercise the live contract only once this room's
Hub runs a tenant image built from that merge (tenant.132+) — on an older Hub these calls fail
with an unknown-tool or unknown-route error, not a bug in this app.**

### Attempt lifecycle

The **Attempt lifecycle** tab (`src/ui/attempt-lifecycle-panel.tsx` +
`src/ui/attempt-observation-section.tsx`) runs as the current user, under the already-approved
`sandbox:generate` scope — no new permission (the hub's `mcp-rest-allowlist.ts` maps all of
`generate-async` / `attempt-status` / `attempt-observation` / `attempt-cancel` / `attempt-evidence`
to that one scope):

- `agents.sandbox.attempt-observation` — phase, pending-question, bounded `output` (plus an
  `outputTruncated` flag), and timestamps for one attempt. Field names match the Hub's own
  `IAttemptObservation` exactly (`privos-sandbox-agent-service.ts` in privos-hub) — there is no
  `logs` field.
- `agents.sandbox.attempt-cancel` — a real worker cancel; the returned status is
  worker-authoritative and never rewrites an already-completed/failed attempt to `cancelled`.
- Caller-stable `operationId` idempotency on `agents.sandbox.generate-async`: the tab dispatches
  once, then re-dispatches the SAME `operationId` with the SAME request and shows the returned
  `attemptId` converges on the first attempt, then re-dispatches the SAME `operationId` with a
  CHANGED prompt and shows the Hub fails that closed (an `operationId` bound to one request can
  never silently rebind to a different one).

### Attempt evidence

The **Attempt evidence** tab (`src/ui/attempt-evidence-panel.tsx`) reads
`agents.sandbox.attempt-evidence` for one attemptId (paste one from the Attempt lifecycle tab),
showing the recorded LLM/gateway calls: model, provider, effort, turn, correlation. Same
`sandbox:generate` scope; no new permission.

### App Objects (CAS) and App Database

The **App Objects (CAS)** tab (`src/ui/app-objects-panel.tsx`) and **App Database** tab
(`src/ui/app-db-panel.tsx`) are the one exception to "every tab runs as the current user": these
MCP tools (`mcpapp.objects.put`/`.head`/`.get`, `mcpapp.db.registerCollection`/`.create`/`.query`/
`.getSchema`) are reached only through `POST /api/v1/mcp-apps.tool-call`, and this app calls that
endpoint authenticated with **its own installation-bot credential** (`PRIVOS_AGENT_BOT_CREDENTIAL`
/ `PRIVOS_AGENT_BOT_USER_ID`, the same reserved env pair `agent-bot-credential-check.ts` already
validates), never the current user's session. The frontend calls this app's own backend tools
`hr_app_object_store` / `hr_app_db_store`; the backend then makes the bot-credential call
server-side:

- `resolve-own-mcp-app-id.ts` — resolves this app's own `mcpAppId` (mode-aware, mirrors
  `resolve-hub-origin.ts`).
- `app-platform-tool-call.ts` — the shared bot-credential transport, built on the SDK's own
  `createAgentBotHubClient`. Mirrors the reference consumer, legal-agent's
  `hub-db-object-store.ts`, byte for byte: same endpoint, same body shape
  (`{ mcpAppId, toolName, arguments, roomId }`).
- `app-objects-demo-tool.ts` / `app-db-demo-tool.ts` — the two backend tool handlers.

**App Objects (CAS)**: `put` computes the sha256 digest of the given bytes itself and sends it as
`sha256:<64hex>` — the Hub independently re-verifies content == digest and rejects a mismatch on
its own side; this panel also re-verifies the digest of what `get` reads back, client-side, on top
of that. Objects are immutable and room-private; a repeated `put` of identical bytes is an
"adopt", not a conflict.

**App Database**: a fixed demo collection (`hr_demo_notes`, room-scoped) is registered once per
room, then create/query/getSchema round-trip a small `{ label, note }` record.

New optional permissions this adds to the manifest: `db:read`, `db:write`, `db:schema:read`,
`db:schema:write` — see [`SCOPES.md`](SCOPES.md) for the exact call-site map and
[`privos-app.json`](privos-app.json) for the declarations.

## Theme inheritance

The **Theme inheritance** tab (`src/ui/theme-inheritance-panel.tsx`) is a visible showcase of
workspace theme inheritance — no permission involved. The Hub pushes the current light/dark mode
plus a curated set of 12 `--base-*` design tokens (primary colour, backgrounds, border, text,
link colour, corner radius, font family) over the same non-secret `HOST_CONTEXT_CHANGED` bridge
push that carries `theme`/`roomId`, re-sent on every mode flip and on a live admin theme save.
`@privos_ai/app-react`'s `PrivosAppProvider` (`^0.6.0`) applies every token onto this document's
`<html>` as a real CSS custom property automatically, before any app code runs.

The tab renders:
- the current mode (`light`/`dark`) and a legend of all 12 tokens — a colour swatch and the
  resolved value for colour tokens, a shape/text sample and the resolved value for radius/font;
- a primary button, a bordered card, and a link, styled purely through `var(--base-*)` — change
  the workspace theme (or flip light/dark) while this tab is open and they restyle live, with zero
  reload and zero app-side event handling;
- a one-line note when the host doesn't provide `themeTokens` (older Hub, or the app running
  standalone outside a Privos workspace), so the degraded case is visible too.

Whole-app theme sync (the `data-theme` attribute + this file's own `--bg`/`--text`/`--accent`
indirection) is a separate, older mechanism — see `theme-provider.tsx` and
`contact-form-styles.css`. This tab exists to make the newer, richer `--base-*` token contract
demonstrably visible on its own.

## License behavior

The manifest declares a Free tier (50 records) and Pro tier (5,000 records plus `bulk-export`).
The backend calls `license.assert('bulk-export')` and `assertWithin('records', count)`. A lapsed Pro
license degrades to Free without deleting records.

Local Pro test:

```bash
PRIVOS_APP_LICENSE='{"tier":"pro","state":"active"}' npm start
```

## UI build and asset delivery

`npm run build` compiles `src/ui` with Vite (`vite.config.ts`: `base: './'`, code-split
`manualChunks`, `build.manifest: true`, `build.sourcemap: false`, `build.assetsInlineLimit: 0`)
into a small shell (`dist/ui/index.html`) plus hashed, content-addressed files under
`dist/ui/assets/`. `@privos_ai/app-server`'s `serveBuiltUi` helper (`src/mcp-message-handlers.ts`)
reads that build output once and answers three kinds of `resources/read` request: the shell
(`ui://ai.privos.mcp-app-demo/form.html`, meta-tagged for relay delivery, with an inline boot
watchdog), the assets manifest (`ui://ai.privos.mcp-app-demo/assets-manifest.json`), and each
individual asset (`ui://ai.privos.mcp-app-demo/assets/<file>`). Any other URI is refused with
JSON-RPC `-32602`.

The Hub fetches the shell once per open and the hashed assets once per installation generation,
caches them, and re-serves everyone from its own origin behind a short-lived per-user token —
**this app's built bundle is never served to end users unmodified from this container**, and it
must never embed a secret (no `VITE_*` build-time env values; the platform's own non-secret
values are read at runtime instead, see [Environment configuration](#environment-configuration)).
Two build constraints follow directly from that: no sourcemaps are ever produced, and nothing may
be served from a Vite `publicDir` — every asset the UI references (including the bundled sample
agent-set archive) must be a real hashed file under `dist/ui/assets/`, which the build enforces at
construction time (`serveBuiltUi` throws on an unhashed, oversized, or `.map` file, or on a shell
with a non-relative asset reference).

**This build requires the installing Hub to be at tenant.N or later** — an older Hub has no route
to fetch the split-out asset files, and the shell's boot watchdog shows a "App assets unavailable
— Retry" panel instead of a blank frame until the tenant is upgraded.

### Signed bundle at publish time

`ui.distDir` in `privos-app.json` is set to `"dist/ui"` — it must match wherever `npm run build`
actually writes the UI, since this is what `privos-app bundle-ui` (`npm run bundle:ui`) packages
into the tar the marketplace build node produces and the Portal signs. At install and upgrade, a
capable Hub pulls that signed bundle, verifies its digest, and preloads the UI into the workspace's
own storage before the app is allowed to go active — this is on top of, not instead of, the
`resources/read` contract `serveBuiltUi` implements above. A version whose UI build output didn't
change reuses the already-stored bundle rather than re-shipping it, so a manifest- or backend-only
version bump does not by itself ship a UI change. See privos-dev-docs:
[mcp-app-platform/ui-bundle.md](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/ui-bundle.md)
for the full mechanism and its refusal codes.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run preflight
npm run docker:build
```

Preflight validates schema v2, canonical hashes, documented call sites, Docker inputs, license
guards, safe source packaging, and the served manifest. Its versioned rules mirror Portal until the
Marketplace validation package is published.

## Safe source packaging

```bash
npm run package
```

This creates `dist-source/ai.privos.mcp-app-demo-2.0.0.zip` plus a SHA-256 provenance file from
Git-tracked source. It rejects dirty trees by default, credential-like files, `.env`, dependencies,
build output, and archives over 200 MiB. `--allow-dirty` is for local inspection only.

The multi-stage image installs only lockfile-pinned package inputs, runs as `node`, supports a
read-only root filesystem, and needs no production credential environment variables.

## Environment configuration

`privos-app.json` declares the values an operator supplies from Hub **Admin → Apps → Settings →
Environment**. The declaration is part of the digest-pinned manifest, so it is fixed per published
version; the Portal validates it at submission and the reviewer sees every secret the app asks for.

| Key | Required | Secret | Purpose |
|-----|----------|--------|---------|
| `HRM_COMPANY_NAME` | yes | no | Company name in the dashboard header. |
| `HRM_LOCALE` | no | no | BCP-47 locale for dates and currency; the app defaults to `en-US`. |
| `HRM_SMTP_PASSWORD` | no | **yes** | SMTP password for payslip mail. |

Two rules this app demonstrates, and every publisher should follow:

- **A required value never blocks installation.** The operator fills it in afterwards, so the app
  must start and report its own unconfigured state. `hr_whoami` returns `companyName: null` rather
  than refusing to run.
- **A secret is reported, never printed.** `hr_whoami` returns `smtpPasswordSet: true|false`. The
  value would otherwise travel through a room, which is precisely what the platform's write-only
  storage exists to prevent.

Applying values restarts the app container. The environment is read at start like any process
environment; there is no runtime config-fetch API.

### Variables the platform injects

`hr_whoami` also echoes what PrivOS injects, read through the SDK's `getPlatformContext()`:

```ts
import { getPlatformContext, publicUrlFor } from '@privos_ai/app-server';

const { publicUrl, accessMode } = getPlatformContext();
const iconUrl = publicUrlFor('/public/icon.svg');
```

`PRIVOS_PUBLIC_URL` is this app's own public origin and `PRIVOS_ACCESS_MODE` is `managed-runtime`
or `publisher-hosted`. Tool calls and interface requests do **not** arrive on the public origin —
those ride the signed broker dispatch on `/mcp`. Use it for public static media, webhook callbacks,
and OAuth redirect URIs. Both helpers are undefined-safe, so the app still runs where nothing is
injected.

## Privacy, support, and release

Marketplace review/build source remains publisher-confidential; buyer workspaces receive the
digest-pinned image. See [`PRIVACY.md`](PRIVACY.md), [`TERMS.md`](TERMS.md), and
[`CHANGELOG.md`](CHANGELOG.md). Support is available through GitHub Issues or `dev@privos.ai`.
