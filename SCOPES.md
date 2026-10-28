# Permission justifications

`privos-app.json` is the authoritative declaration. Every operation is bound to the verified current room and verified caller before the onboarding service is invoked.

| Permission | Requirement | Why / call site | Behavior when absent |
|---|---|---|---|
| `basic:information` | Required | Supplies the approved installation and room context used by the PrivOS host bridge. | Installation cannot continue safely. |
| `bot:room:join` | Required | `ui/onboarding/api.ts` joins the installation-owned service bot to the verified current room before the backend initializes room-scoped data. | The service bot cannot access this room's App Database. |
| `rooms:roles:read` | Required | Supplies signed `room_roles` and `workspace_roles` claims consumed by `onboarding/auth.ts`. Owner/moderator and workspace admin become Admin; leader/member remain Learners. | Admin access cannot be derived safely. |
| `rooms:read` | Required | `onboarding/assignments.ts` and `onboarding/tools.ts` list current-room members before an Admin assigns onboarding. | Admin cannot select or validate assignees. |
| `notifications:write` | Optional | `onboarding/notifications.ts` sends assignment, reminder, and published-evaluation notifications. | The database action remains committed and the UI reports a non-blocking delivery warning. |
| `files:read` | Required | The onboarding UI lists, opens, and previews assigned room files. | Learners cannot complete required materials. |
| `files:write` | Required | The Admin AI generator uploads source documents into the current room before bounded extraction. | Admin cannot add file-backed sources for AI generation. |
| `sandbox:generate` | Optional | `ui/onboarding/ai/ai-gateway-sandbox.ts` dispatches and observes source-grounded template generation through documented PrivOS Sandbox REST routes as the logged-in Admin. | Sandbox dispatch is unavailable; generation can use Native AI Chat when both Native scopes are granted. Existing templates remain usable. |
| `sandbox:ai-chat` | Optional | `ui/onboarding/ai/ai-gateway-native-chat.ts` observes the exact room-bound Native reply during direct Native generation or recovery from a Sandbox provider failure. | New jobs can still use Sandbox, but failed provider attempts cannot fall back to Native AI Chat. |
| `sandbox:ai-chat:write` | Optional | `ui/onboarding/ai/ai-gateway-native-chat.ts` sends and starts room-bound Native generation, directly or after a Sandbox failure; long context is referenced from a room file. | New jobs can still use Sandbox, but failed provider attempts cannot fall back to Native AI Chat. |
| `db:read` | Required | `onboarding/store.ts` reads templates, assignments, progress, attempts, answers, feedback, evaluations, and audit events. | Onboarding state cannot load. |
| `db:write` | Required | `onboarding/store.ts` persists every room-scoped onboarding record, including module approvals, room/project leases, and publication checkpoints. | Progress and Admin actions cannot be saved. |
| `db:schema:read` | Required | The onboarding schema bootstrap verifies registered collections before use. | Schema compatibility cannot be confirmed. |
| `db:schema:write` | Required | `onboarding/schema.ts` registers the 19 versioned onboarding collections and indexes per room, including unique room/project leases and publication batch IDs. | The room-scoped data model cannot be provisioned. |

App Database and best-effort notification calls run through the app service identity. Human authorization is still resolved exclusively from the Hub-verified actor attached to the incoming MCP call; no browser-provided identity or room selector is trusted.
