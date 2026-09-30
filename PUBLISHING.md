# Packaging and publishing this app to the PrivOS marketplace

The process, in order, with the checks that actually reject a submission. Every
rule below is enforced by the Portal, not by convention — the error codes are
the ones it returns.

Publisher API base: `https://portal.privos.io/api/cloud/marketplace`.

---

## 0. Before you package

You need a **creator enrolment** (a `MarketplaceCreator` record) on the
`client.privos.io` account that will own the listing, and nothing else — the
`privos-app publish` CLI (§3–§4) authorizes interactively in your browser, so
there is no cloud session to hand-mint. A listing you do not own cannot be
updated.

Decide the version first. `privos-app.json:version`, `package.json:version`, and
the `semver` you post when creating the version must all be the same string, or
version creation is refused.

**A Marketplace listing and a standalone install run the exact same manifest.**
Nothing below is specific to the managed Marketplace runtime: `privos-app.json`
is the one reviewed manifest for both a `managed` install (App Cluster) and a
`standalone-production` install (self-hosted against a portal-less Hub, see
[README.md § Standalone production](README.md#standalone-production-self-hosted-against-a-standalone-hub)).
A standalone Hub pins the same canonical manifest digest this pipeline
computes at pairing time, and `/ready` refuses to serve once the local
manifest drifts from it — the standalone analogue of this pipeline's
digest-pinned image label.

---

## 1. Regenerate and lint the manifest

```bash
npm run build          # vite build + generate-manifest.ts + manifest:lint
npm run manifest:lint  # privos-app lint privos-app.json
```

`manifest:lint` prints the two pins you will need later:

- `canonicalManifestHash` — sha256 over the **whole** manifest serialized with
  every object key sorted recursively. The Hub recomputes it at install time and
  refuses a mismatch, and the built image must carry it as the label
  `io.privos.manifestDigest`.
- `publisherPermissionDeclarationHash`.

### Check the permission catalog before anything else

Every declared permission is validated against the Portal's catalog
(`marketplace-mcp-permission-catalog.ts`). Three ways it rejects:

| Error | Meaning |
|---|---|
| `PROPOSAL_PERMISSION_UNKNOWN` | the scope is not in the catalog (or has been retired) |
| `PROPOSAL_PERMISSION_CONTEXT_INVALID` | scope declared in a `context` it does not allow |
| `PROPOSAL_PERMISSION_EXECUTION_INVALID` | scope declared for an `executionContext` it does not allow |

A retired scope is the expensive one: it fails **new** submissions while every
already-installed copy keeps working, so nothing in the running fleet warns you.
`bot:agent:create` was retired when creating the installation bot became an
administrator's action taken under the manifest's own `agentBot` declaration.

If a release needs a scope the deployed Portal does not know yet, the Portal
must gain it and be redeployed **first**. Otherwise cut the release from the
last published commit and cherry-pick, so the reviewed permission set is
unchanged.

**2.15.0 example**: the four App Platform demo tabs (see README.md § App Platform demo tabs)
declare `db:read` / `db:write` / `db:schema:read` / `db:schema:write` — scopes introduced by the
Step-1 generic platform contract (merged hub `bff01ee8`). Do not submit this version against a
Portal whose `MCP_PERMISSION_CATALOG_VERSION` predates that merge; it will reject with
`PROPOSAL_PERMISSION_UNKNOWN` for all four. The corresponding MCP tools also only run once the
installing tenant's Hub image is built from tenant.132+ — a successful submission against an
up-to-date Portal does not by itself mean those tabs work on every existing tenant yet.

### Split UI assets need no new permission, but do need a Hub floor version

**2.16.0 example**: `npm run build` now produces a small shell plus hashed `assets/` files
(`serveBuiltUi`, see README.md § UI build and asset delivery) instead of one inlined bundle. This
declares no new permission — the publisher permission declaration hash is unchanged from 2.15.1 —
so it submits and passes review against any Portal. What it does need is **the installing tenant's
Hub to already be on tenant.N or later**, the first release with the route that fetches these
split-out assets. Promoting 2.16.0 to a tenant on an older Hub does not fail submission or install;
the app's UI shows the shell's "App assets unavailable — Retry" panel instead of rendering, until
that tenant's Hub is upgraded. Release order matters here the same way it does for a permission gap:
get the fleet's Hub to tenant.N first, then promote this app version.

---

## 2. Run the local mirror of the Portal's rules

```bash
npm run preflight
```

This mirrors the marketplace checks that are cheap to run locally — manifest
field set, identity fields agreeing with `package.json`, and the lockfile
version matching the app version. The build node runs `npm ci` against the
committed lockfile, so a stale lock is a broken publication waiting to happen.

Then the real gates:

```bash
npm run typecheck && npm test && npm run docker:build
```

### Check the UI bundle too

```bash
npm run build
npx -p @privos_ai/app-server privos-app bundle-ui --check
```

`--check` runs the same build-and-budget validation the build node's `ui-build`
stage runs against `ui.distDir` (`dist/ui` for this app), without writing a
tar — it catches a wrong `ui.distDir`, an oversized/unhashed asset, or a
budget overrun (≤ 2 MB/file, ≤ 256 files, ≤ 64 MB total) before you spend a
real submission on it. See privos-dev-docs:
[mcp-app-platform/ui-bundle.md](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/ui-bundle.md).

---

## 3. Package the source archive

```bash
npm run publish:marketplace -- --dry-run
```

This packages the app the same way `privos-app publish` does for a real
publish (see §4) but stops before authorizing or uploading — use it to
inspect the archive's git revision and sha256 before committing to a
publish run.

Packaging refuses a dirty tree unless `--allow-dirty` is passed, scans the
worktree for credential-like files, builds the zip with `git archive`, then
re-inspects the produced archive's own ZIP entries and enforces the size
limits below — never from a `git ls-tree` sweep, since that can't reflect
`.gitattributes export-ignore` or `--allow-dirty` additions the way the
produced archive does.

What the archive **must** contain, at the root:

- `privos-app.json` — otherwise `MISSING_REQUIRED_ENTRY`
- `Dockerfile` — otherwise `MISSING_REQUIRED_ENTRY`

What it must **not** contain, rejected as `DENIED_PATH_IN_ARCHIVE`:

- `.git/`, `node_modules/`, `dist/`, `dist-source/`, `.privos/skills/`, any
  `..` traversal
- any `.env*` path — the rule is `(^|/)\.env(\.|$)`, so **`.env.example`
  counts**
- credential-like paths (`id_rsa*`, `*.pem`, `*.key`, anything containing
  `credentials`)

Exclusion is handled by `.gitattributes` `export-ignore` entries, which is why
`git archive` drops `.env.example` and the agent-context files. Add a new
entry there rather than deleting files from the zip by hand.

Other archive limits: `.zip` only, 1 byte – 200 MB total, ≤ 20,000 entries,
≤ 50 MB per file.

`scripts/package-source.sh` implements the same policy independently and is
**retained only as a parity check** — run it in CI or by hand if you want a
second, non-CLI confirmation that packaging behaves the same way; it is not
part of the publish path anymore.

---

## 4. Authorize, upload, create the version, submit — `privos-app publish`

```bash
npm run publish:marketplace              # interactive: prints a browser approval URL
PRIVOS_PUBLISHER_TOKEN=pvp_xxx npm run publish:marketplace -- --yes   # CI, after the first interactive publish
```

`privos-app publish` (bin from `@privos_ai/app-server`, already a dependency
of this app) replaces the manual archive-then-eight-API-calls flow. In one
command it: packages (§3) → authorizes → uploads the archive in sequential
parts → creates the version → submits → waits up to 60 s for preflight to
leave `PREFLIGHT_PENDING`.

**Authorization, two modes, both ending in the same scoped grant the Portal
honors on the publish routes:**

- **Interactive (default).** The CLI prints a URL on
  `client.privos.io/marketplace/publish?user_code=…` and a short user code.
  Open it, log in with your **client.privos.io account**, confirm the
  listing/version/requester shown, and approve. The CLI polls automatically —
  do not re-run `publish` while it waits. This is the only mode that works
  the **first** time a listing is published (a human must bind the listing to
  the manifest once).
- **Publisher token (CI).** Generate one in Creator Studio (a step-up action:
  email code or magic link, plus TOTP if your account has 2FA), export it as
  `PRIVOS_PUBLISHER_TOKEN` in your CI's secret store — **never** paste it into
  chat, a command argument, or a file — and re-run with `--yes`. Only works on
  a listing whose first version was already approved interactively; otherwise
  the CLI fails with `LISTING_NOT_BOUND`.

An upload can be claimed by exactly one version; the CLI drives the entire
multipart sequence itself, so there is no manual session/expiry bookkeeping.

For the full flag list, the `--json` NDJSON event stream, exit codes, and the
error-code-to-remediation table (`VERSION_SEMVER_EXISTS`, `PREFLIGHT_FAILED`
vs `PREFLIGHT_BLOCKED_INFRA` vs the listing-content gate in §6, etc.), see the
Claude skill shipped with the CLI:
`node_modules/@privos_ai/app-server/skill/SKILL.md` (also scaffolded into
`.claude/skills/privos-app-publish/` for apps created with
`create-privos-mcp-app`).

A legacy hand-driven `.mjs` script from before this CLI existed (minting a
cloud session by hand and calling the Portal's ~8 publish endpoints directly)
is **retired** — it predates the authorization/grant model above and must not
be used.

---

## 5. The review pipeline

```
UPLOADED → PREFLIGHT_PENDING → SCANNING → SCANNED_PENDING_AI
        → READY_FOR_REVIEW → APPROVED_BUILD_PENDING → PUBLISHED
```

Automatic: preflight, security scan, and the AI review — which is **advisory**
and routinely returns a flag without blocking. If the AI reviewer is
unavailable the version still reaches `READY_FOR_REVIEW`.

Human, by an admin at `POST /reviews/:versionId/decision`: `APPROVE`,
`REQUEST_CHANGES`, or `REJECT` (the latter two need a reason). Only `APPROVE`
starts the build.

Failure states and who clears them:

| State | Meaning | Cleared by |
|---|---|---|
| `PREFLIGHT_FAILED` | manifest, Dockerfile, or policy problem | publisher fixes and resubmits |
| `PREFLIGHT_BLOCKED_INFRA` | infrastructure only: build node unreachable / transfer failed | admin retries, no new upload |
| `CHANGES_REQUESTED` | reviewer asked for changes | publisher resubmits — no new upload needed if the source is unchanged |
| `IMAGE_SCAN_FAILED` | image built but failed its scan | admin, after the finding is resolved |
| `REJECTED` | terminal for that version | new version |

---

## 6. Build and publish

Approval enqueues the platform build. The build node builds the `Dockerfile`
from the **reviewed source**, pushes to the mesh registry
`10.88.0.11:5000/marketplace/{listing-slug}`, scans the image, and verifies it
carries `io.privos.manifestDigest` matching the canonical manifest digest
exactly. Only then does the listing move to `PUBLISHED`.

Marketplace publishing is open to enabled creators only. For anyone else the
Portal refuses the source upload with `403 PUBLISHER_NOT_ENABLED` before it
stores anything, so no version is created; `privos-app publish` (SDK 0.12.3 or
later) prints the message and exits 2. The app can still run in your own
workspace as a Standalone Relay app.

### Listing content gates

A first version is refused at version creation with
`409 LISTING_CONTENT_INCOMPLETE`, and the build blocks at
`APPROVED_BUILD_PENDING` with `listing_content_incomplete`, unless the listing
already has all of:

- `primaryCategoryId`
- ≥ 3 `features`, ≥ 2 `useCases`
- `documentationUrl`, `privacyUrl`, `termsUrl`
- `supportEmail` or `supportUrl`
- an approved `ICON`
- ≥ 2 approved `SCREENSHOT` media, each with a `caption`

These live on the **listing**, not in `privos-app.json`, and are uploaded
through the same upload endpoint with `kind: ICON | HERO | SCREENSHOT`
(PNG/JPEG/WebP; icon ≤ 2 MB, others ≤ 10 MB; `altText` required). The assets in
`launch-kit/` exist for this step.

Data-policy disclosure is split: `dataPolicy` in the manifest describes what the
app does; `externalDestinations`, `dataCategories`, `dataResidency`,
`dataRetention`, and `uninstallDataPolicy` are listing fields.

---

## 7. Rejection quick reference

| Code | Fix |
|---|---|
| `size` / `extension` | zip only, 1 byte – 200 MB |
| `denied_path` | remove the path, usually via `.gitattributes export-ignore`; check `.env.example` first |
| `manifest_missing` | `privos-app.json` must be committed and at the archive root |
| `dockerfile_missing` | `Dockerfile` at the archive root |
| `PROPOSAL_PERMISSION_*` | see §1 — catalog, context, execution context |
| `listing_content_incomplete` | see §6 |
| manifest digest mismatch at install | the image label disagrees with the manifest; rebuild from the reviewed source |

---

## 8. After publishing

Install the published version into a throwaway tenant room and exercise the
paths the release changed. A published listing is what workspaces install; a
broken one is not fixed by a rebuild of the same version, only by a new one.

The signed UI bundle is content-addressed: a version whose UI build output is
byte-identical to the previous one reuses the already-stored bundle rather
than shipping a new one. **Shipping a UI-only change needs a UI source
change** — bumping only `privos-app.json`/`package.json`'s version, or
changing only the backend, does not by itself push new UI to installed
workspaces. See privos-dev-docs:
[mcp-app-platform/ui-bundle.md](https://github.com/PrivOS-AI/privos-dev-docs/blob/main/mcp-app-platform/ui-bundle.md).
