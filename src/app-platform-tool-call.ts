/**
 * Shared server-side transport for this app's room-scoped App Platform tools.
 *
 * Both tool families are ONLY reachable through `POST /api/v1/mcp-apps.tool-call`
 * — the mediated `app.callServerTool()` / `app.rest()` host bridges the
 * frontend uses everywhere else in this app always run AS THE CURRENT USER
 * but this endpoint is always `execution: 'user'` at
 * the Hub's grant resolver in the sense that it authenticates the CALLER as a
 * Rocket.Chat user — and when that caller authenticates with this app's own
 * agent-bot header credential (`x-user-id` + `x-auth-token`), the "user" the Hub resolves grants for IS
 * the bot's own account, not a human's. This mirrors the reference consumer,
 * legal-agent's `hub-db-object-store.ts`, byte for byte: same endpoint, same
 * body shape (`{ mcpAppId, toolName, arguments, roomId }`), same
 * bot-credential transport (`createAgentBotHubClient` from the SDK).
 */
import { createAgentBotHubClient } from '@privos_ai/app-server';

import { resolveHubOrigin } from './resolve-hub-origin';
import { resolveOwnMcpAppId } from './resolve-own-mcp-app-id';

const TOOL_CALL_PATH = '/api/v1/mcp-apps.tool-call';

export type AppPlatformToolCaller = (
	toolName: string,
	args: Record<string, unknown>,
	requiredScope: string,
	roomId: string,
) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Call one room-scoped App Platform tool as this app's own
 * installation bot. Throws a plain `Error` with a hub-provided or
 * transport-provided message on any failure. Onboarding services let it
 * propagate to the frontend's structured `tools/call` error path.
 */
export async function callAppPlatformTool(
	toolName: string,
	args: Record<string, unknown>,
	requiredScope: string,
	roomId: string,
): Promise<unknown> {
	const mcpAppId = await resolveOwnMcpAppId();
	if (!mcpAppId) {
		throw new Error(
			"This app cannot resolve its own installation id yet, so it cannot call the Hub's App Platform " +
				'tools. In development, re-run `npm run pair` (or `npm run dev`) so the cached credentials include ' +
				'MCP_APP_ID; in managed/standalone-production this resolves automatically once paired.',
		);
	}

	const roomHub = createAgentBotHubClient({ resolveHubOrigin });
	const response = await roomHub.authorizedFetch(TOOL_CALL_PATH, {
		method: 'POST',
		requiredScope,
		retryMode: 'never',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ mcpAppId, toolName, arguments: args, roomId }),
	});

	const raw = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	} catch {
		parsed = {};
	}
	if (!response.ok || parsed.success === false) {
		const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
		throw new Error(`${toolName} failed: ${reason}`);
	}

	const content = Array.isArray(parsed.content) ? parsed.content : [];
	const first = asRecord(content[0]);
	if (typeof first.text !== 'string') {
		throw new Error(`${toolName} returned a malformed tool result`);
	}
	try {
		return JSON.parse(first.text);
	} catch {
		throw new Error(`${toolName} result is not valid JSON`);
	}
}
