# Selective Hub Retry Design

## Intent

Keep the Onboarding UI available when a transient container-to-Hub connection attempt fails with `AgentBotHubUnreachableError`, without replaying operations that could create duplicate writes or notifications.

## Evidence

- Disabling room collocation does not change the failure: the installation still uses `standalone-relay`.
- `onboarding_bootstrap` fails with `agent_bot_hub_unreachable` after roughly 10–25 seconds.
- The container resolves the Hub origin and completes DNS, TCP, and TLS checks.
- The same authenticated App Database read succeeds from a fresh process, while repeated fresh HTTPS connections intermittently fail with `UND_ERR_CONNECT_TIMEOUT`.
- Bootstrap prepares 17 collections with `registerCollection` plus `getSchema`; one transient failure currently aborts the entire load.

## Goals

- Retry only operations whose replay is safe.
- Retry only `AgentBotHubUnreachableError`; preserve existing behavior for permission, validation, credential, and Hub response errors.
- Bound retries and backoff so failures still surface promptly.
- Preserve the existing successful per-room schema cache.
- Cover retry classification and exhaustion with automated tests before changing production code.

## Non-goals

- Do not change room collocation, installation mode, Hub configuration, or credentials.
- Do not retry notifications, deletes, or writes without an explicit idempotency key.
- Do not hide persistent Hub outages or replace errors with empty data.
- Do not refactor unrelated onboarding services or UI behavior.

## Approaches considered

1. **Explicit replay-safe opt-in at each call site — selected.** Extend the platform caller with an optional retry policy. Read operations, schema registration/verification, and writes carrying an idempotency operation ID opt in. Unsafe writes retain one attempt. This is auditable and fail-closed for new call sites.
2. Infer safety from tool names centrally. This is less repetitive, but a future tool or argument-level idempotency rule could be classified incorrectly without an obvious call-site review.
3. Retry every platform call. This is smallest mechanically but can duplicate records or notifications, so it is rejected.

## Design

`callAppPlatformTool` gains an optional final options object with `replaySafe: true`. Without it, behavior is unchanged.

For replay-safe calls, the complete authorized Hub request is attempted at most three times. Only `AgentBotHubUnreachableError` is retried, with short bounded exponential delays (200 ms then 400 ms). A successful response returns normally. A non-reachability error, a rejected Hub response, or exhaustion rethrows the original observable error path.

Initial opt-in call sites:

- `mcpapp.db.registerCollection` and `mcpapp.db.getSchema`.
- App Database reads: `get`, `query`, `count`, and `aggregate`.
- `mcpapp.files.get` and `mcpapp.rooms.getMembers`.
- Database creates/updates only when the existing call already carries a non-empty `operationId` recognized by the Hub.

Notifications, soft deletes, and database writes without an operation ID remain single-attempt.

The existing `schemaPreparation` promise cache remains the owner of successful per-room preparation. Retries happen below it, so a transient network miss no longer forces the next UI retry to restart all schema work.

## Verification

1. Add focused tests that first fail because replay-safe calls are not retried.
2. Verify transient reachability errors recover, non-transient errors are not retried, unsafe calls remain single-attempt, and retries stop after three attempts.
3. Run typecheck, the focused tests, the full test suite, build, and preflight.
4. Build/recreate the Docker app as required by the repository instructions.
5. Reload the provided Chrome URL and confirm the dashboard renders instead of `agent_bot_hub_unreachable`.

## Operational handoff

If the Hub requires an installation Refresh/Repair after the new container is running, stop and ask the user to perform it. Ordinary browser reload and local Docker rebuild/recreate may be performed as part of verification.
