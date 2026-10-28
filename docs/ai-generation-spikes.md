# AI generation Phase 0 spikes

Date: 2026-10-23

App: `ai.privos.mcp-app-onboarding-dev` / installation `6ad87c38fbc62e6c0f76918d`

Room: `6a8fe12e6ce994baa36f3ab3`

## Baseline

- `npm run typecheck:strict-unused`: passed.
- Manifest, scope-audit, permission-catalog, and onboarding-tools tests: 18/18 passed before the spike changes.
- Existing dirty learner file/download fixes were preserved.

## S1 — Sandbox async generation from the iframe

Status: **passed; adapter A selected**.

The manifest requests optional room/user scope `sandbox:generate`. The tested iframe adapter calls:

- `POST agents.sandbox.generate-async`
- `GET agents.sandbox.attempt-status?roomId&attemptId`

The first real dispatch was correctly denied while the room-specific optional permission remained disabled. Admin approval of the manifest alone did not change the room grant. The room's **Customize access → Run sandbox agent** control was then enabled and saved; the refreshed SDK context included `sandbox:generate`.

The live SDK returned successful REST bodies already unwrapped rather than the typed `{ statusCode, body }` envelope. The gateway now accepts both shapes. Observed dispatch body:

```json
{"attemptId":"sandbox-attempt-…","taskId":"6a8fe12e6ce994baa36f3ab3",
 "source":"global","adopted":false,"replayed":false,"success":true}
```

The short attempt reached `completed` and returned exactly `{"probe":"ok"}` in about 10 seconds including browser/tool polling overhead. Reusing the same `operationId` returned the same attempt reference. Reusing it with different input failed closed with `operationId is already bound to a different Sandbox request`.

A second attempt with about 150,000 characters of `systemContext` also reached `completed` in about 10 seconds and returned exactly `{"largeContext":"ok"}`.

Decision: use Sandbox adapter A. S2 native AI Chat fallback was not run because S1 passed with the narrower intended permission.

## S3 — large file through the host bridge

Status: **passed at 2 MiB; 5 MiB rejected**.

- A 5 MiB source encoded for `uploadFile` failed at the Hub/proxy boundary with a non-JSON HTML response.
- The same upload/read/delete round trip at 2 MiB succeeded.
- Read-back size: 2,097,152 bytes.
- Round-trip time: 3,190 ms.
- The temporary room file was deleted successfully.

Decision: v1 source file limit is 2 MiB. No chunked upload is added in v1.

## S4 — PDF and DOCX extraction in the production image

Status: **passed**.

Installed pure-JavaScript `unpdf` and `mammoth`. A one-shot smoke test ran in the production image with:

- read-only root filesystem;
- `--memory=256m --memory-swap=256m`;
- all capabilities dropped, `no-new-privileges`, PID limit 100;
- writable 64 MiB `/tmp` only.

Both an in-memory one-page PDF (598 bytes) and an in-memory minimal DOCX (1,450 bytes) produced their exact expected text. The repeated extraction run took 134 ms and observed RSS was 102,281,216 bytes.

## S5 — five collections and a large JSON snapshot

Status: **passed**.

The existing room bootstrapped all five new room-scoped collections, taking the onboarding schema from 12 to 17 collections:

- `onboarding_sources`
- `onboarding_ai_jobs`
- `onboarding_template_content`
- `onboarding_module_progress`
- `onboarding_module_attempts`

A representative `onboarding_template_content.content` JSON value was created and read back:

- serialized JSON size: 614,445 bytes;
- payload length: 614,400 characters;
- marker matched after read;
- the spike record was deleted successfully.

Decision: keep sections and template content in App Database JSON fields; the object-store fallback is not required.

## S6 — Model-B JSON quality

Status: **split required**.

The same bounded Model-B prompt was dispatched three times with distinct `operationId` values.

- Run 1: still running when the threshold decision was made.
- Run 2: completed with 23,471 characters, but the single JSON object was structurally incomplete (`Expected ',' or ']' after array element` at end of output).
- Run 3: terminal `failed` with no usable text.

Even a valid Run 1 can produce at most 1/3 valid outputs, below the required 2/3 threshold. The one-call Model-B output is too large and unreliable for this contract.

Decision: split Model-B into two resumable calls:

1. **B-lessons** — title, description, generation notes, module frames, objectives, feature coverage, and lesson blocks.
2. **B-questions** — questions and question metadata for the already validated module/block IDs.

Each call is parsed, grounded, and validated before the next call. A failed/invalid call is repaired independently and does not require regenerating the other half.
