# Inventory analysis Native fallback

## Intent

Prevent source-batch analysis from stopping on a PrivOS Sandbox infrastructure crash when the workspace has granted Native AI Chat access. Admins should not have to diagnose or manually repeat a recoverable provider handoff.

## Goals

- Keep Sandbox as the primary provider.
- When an inventory-analysis Sandbox attempt ends with a terminal infrastructure/provider failure such as `worker_failed`, retry that failed call through Native AI Chat exactly once.
- Preserve the existing job, source selection, diagnostics, and progress history.
- Show the Sandbox failure and the transition to Native in the progress UI.
- Stop and show actionable diagnostics if Native also fails.

## Non-goals and safety constraints

- Do not retry invalid AI output, document parsing errors, authorization errors, cancellations, or user/data validation failures through Native automatically.
- Do not create an unbounded retry loop or dispatch Sandbox and Native concurrently.
- Do not change template-generation, review, publish, or Roomfiles behavior.
- Do not use Native unless both `sandbox:ai-chat` and `sandbox:ai-chat:write` are granted.

## Approaches considered

1. **One bounded automatic handoff — selected.** Sandbox remains primary; a recognized terminal Sandbox infrastructure failure queues the failed inventory call again and pumps it through Native once. This removes the unnecessary Admin retry while retaining Sandbox-first behavior.
2. **Manual selective retry — current behavior.** Admin presses **Thử lại**, after which the existing `AI_FAILED` state selects Native. This is safe but makes the fallback look broken and interrupts the workflow.
3. **Always use Native for inventory analysis.** This avoids Sandbox crashes but abandons the intended primary provider and uses Native even when Sandbox is healthy.

## Implementation shape

- Add a small, testable recovery classifier/orchestrator for inventory jobs.
- Classify provider failures from the failed Sandbox call, including `worker_failed` and the corresponding worker-exit message, rather than treating every `AI_FAILED` as infrastructure failure.
- Reuse the existing server-owned `retry_job` action so the new call is recorded in the same job and audit trail.
- Pump the retry with the Native gateway only when Native capability is available and no unresolved Native cleanup fence exists.
- Bound the orchestration to the original Sandbox pass plus one Native pass.
- Add focused tests for eligible failure, ineligible failure, missing permission, Native failure, and no duplicate dispatch.

## Success criteria

For an inventory call that fails as Sandbox `worker_failed`, the UI proceeds automatically to one Native attempt and completes analysis when Native succeeds. The job history shows both attempts. Any second failure stops with full diagnostics, and all non-eligible failures retain their current behavior.
