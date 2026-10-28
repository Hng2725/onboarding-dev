# Changelog

This project follows Semantic Versioning. `package.json`, `package-lock.json`, `privos-app.json` and this file must describe the same release.

## [2.20.0] - 2026-10-24

### Added

- `onboarding_admin_ai` action `record_attempt_cleanup` and per-call `provider`, request-size and cleanup metadata (`pending`/`confirmed`/`unknown`). Prompt text and source content are never stored in this metadata.
- Cancelling a job confirms the provider attempt reached a terminal state (1-second polling, up to 15 seconds) and records the outcome; an unconfirmed Native attempt blocks new Native dispatches until **Kiểm tra lại trạng thái** confirms it stopped.
- Module-scoped repair for new template jobs: lessons are validated before questions, and a repair sends and returns only the failing modules.
- Progress shows each planned step once, in words, with provider and elapsed time.

### Fixed

- AI context files are wrapped to short lines; PrivOS agents previously truncated the single long line, re-chunked it with subagents and searched the project for frame keys, which caused multi-minute stalls, "agent stopped" failures and prose before the JSON answer.
- Prompts now list the allowed frame keys, module range, block rules and flag severities; question calls receive lessons as context data instead of inside the instruction.
- Recurring harmless flag shapes (copied inventory IDs, top-level `featureId`, public-ID location keys, severities fixed by flag type, a single note string) are normalized before validation instead of triggering repairs.
- Native AI Chat answers may contain agent narration before the final JSON object.
- Failed or retried jobs now actually release their lease and clear the previous error; JSON store updates had silently dropped the `undefined` clears.
- Opening the AI generator no longer waits for provider cleanup; a refresh adopts the recorded attempt through its persisted provider and keeps its original 15-minute deadline, and a timed-out attempt is asked to stop.
- PrivOS agent credential and agent-stopped errors are explained in Vietnamese.
- Question prompts state the option shape `{id,label}`, `text` is accepted as the label, and repair scope is computed from every validation error instead of the first 30 (previously each repair could reach only two modules).

## [2.19.6] - 2026-10-23

### Fixed

- The modal now immediately reflects the server-confirmed cancelled job even when the provider cancellation bridge times out, and clearly reports that background cleanup will be retried.

## [2.19.5] - 2026-10-23

### Fixed

- Cancelling an AI job now also cancels its in-flight Sandbox or Native AI provider attempt instead of leaving background generation running.
- Opening the AI generator cleans up Native attempts left behind by previously cancelled jobs, preventing the next fallback retry from being rejected as already running.

## [2.19.4] - 2026-10-23

### Fixed

- A new job created after cancelling an older Native attempt now starts with the primary Sandbox gateway; only an exact provider failure or a resumed Native attempt selects the fallback.

## [2.19.3] - 2026-10-23

### Fixed

- Multi-step Native AI jobs now receive a separate 15-minute polling window per AI call instead of sharing one timeout across the whole job.
- Cancelled jobs are labelled as cancelled instead of appearing completed.
- The UI runtime integration test now allows the same 10-second startup window as its health-check helper under full-suite contention.

## [2.19.2] - 2026-10-23

### Fixed

- Stage D now verifies each procedure step and each learning-content sentence independently, and checks scored questions using only the prompt, correct answer and explanation.
- Omitted AI verdicts now become review warnings as specified instead of forcing an unnecessary repair loop.
- Running AI jobs can now be cancelled while polling is active.

### Changed

- Verification batches now carry up to 20 claims (within the 80-claim specification limit) to reduce long Native AI Chat generation runs.

## [2.19.1] - 2026-10-23

### Fixed

- AI permission checks now derive all scopes from one host context, preventing SDK callback replacement from hiding an already-granted `sandbox:generate` scope.
- Bumped the patch version so workspace admins can review and include the two optional Native AI Chat scopes in the approved permission ceiling.

## [2.19.0] - 2026-10-23

### Added

- Native AI Chat fallback for retries after the PrivOS Sandbox provider returns `AI_FAILED`.
- Room-file context handoff for fallback prompts so long source-grounded jobs remain bounded.

### Fixed

- Verification retries now preserve the correct claim-batch mapping and run before later queued batches.
- AI progress now names the actual active or failed call instead of the final pending call.

## [2.18.0] - 2026-10-23

### Added

- AI-only template creation from room PDF/DOCX/Markdown/TXT/HTML sources and verified Admin notes.
- Resumable server-owned AI jobs with split generation, bounded repair, claim verification, evidence citations and review flags.
- Editable AI drafts, optimistic revision checks, guarded publishing and immutable versioned updates after publication.
- Per-module learner experience with lesson completion, randomized quizzes, retry/support states, Admin retry grants and question statistics.
- Dashboard indicators for modules needing support and open AI review flags.

### Changed

- Removed manual template creation and system-template cloning from both visible UI actions and production service actions.
- AI templates use per-module assessment; existing system/custom templates retain the legacy final-exam workflow.
- Assignment snapshots pin AI content/version and learner DTOs continue to hide answer keys before submission.

### Security

- Added optional least-privilege `sandbox:generate`; missing permission disables AI creation without a manual fallback.
- Enforced room isolation, source limits, fail-closed structured output, grounded quotes and cross-room/member rejection.
- Source uploads are limited to 2 MiB and image-only/scanned PDFs are rejected because OCR is not enabled.

## [2.17.18] - 2026-10-20

### Added

- Complete room-scoped PrivOS onboarding product for Admin and Learner roles.
- Manual member assignment with normal/advanced classification and pinned template versions.
- Immutable built-in PrivOS learning templates plus custom template drafts, file uploads and publishing.
- Required-material progress gate, recovery drafts, idempotent submissions and automatic multiple-choice scoring.
- Comment-only essay feedback, separate overall evaluation and exact `Đạt`/`Không đạt`/`Làm lại` conclusions.
- Responsive light/dark UI with free Ant Design icons and reduced-motion support.

### Security

- Fail-closed mapping from verified room/workspace roles; UI-supplied actor and room values are never trusted.
- Learner access is bound to the verified actor and sanitized DTOs hide answer keys and internal identifiers.
- Every onboarding record is room-scoped and sensitive write operations use idempotent operation IDs.

### Removed

- All legacy demo UI panels, demo backend tools, license examples, sample archives and stale Marketplace media.
