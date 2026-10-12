/**
 * Backend handler for the `hr_app_db_store` tool — demonstrates the
 * `mcpapp.db.*` room-scoped App Database MCP tools (Step-1 generic platform
 * contract, merged hub `bff01ee8`, live only on tenant.132+).
 *
 * Fixed demo schema, registered once per room on first use
 * (`mcpapp.db.registerCollection`), then create/query/getSchema round-trip a
 * tiny record. Runs with this app's own installation-bot credential via
 * `POST /api/v1/mcp-apps.tool-call` — see `app-platform-tool-call.ts`.
 */
import type { VerifiedActor } from '@privos_ai/app-server';

import { callAppPlatformTool } from './app-platform-tool-call';
import { resolveCallerRoom } from './caller-room';

const DEMO_COLLECTION = 'hr_demo_notes';
const DEMO_SCHEMA_FIELDS = [
	{ name: 'label', type: 'string', required: true, maxLength: 200 },
	{ name: 'note', type: 'string', required: false, maxLength: 2000 },
] as const;

export interface AppDbStoreArgs {
	action: 'registerCollection' | 'create' | 'query' | 'getSchema';
	/** Optional: when present it must equal the verified caller's room. */
	roomId?: string;
	label?: string;
	note?: string;
}

export async function handleAppDbStoreTool(
	args: AppDbStoreArgs,
	actor: VerifiedActor | undefined,
): Promise<Record<string, unknown>> {
	const roomId = resolveCallerRoom(actor, args.roomId);

	if (args.action === 'registerCollection') {
		try {
			const schema = await callAppPlatformTool(
				'mcpapp.db.registerCollection',
				{ collection: DEMO_COLLECTION, scope: 'room', fields: DEMO_SCHEMA_FIELDS, indexes: [] },
				'db:schema:write',
				roomId,
			);
			return { registered: true, alreadyRegistered: false, schema };
		} catch (error) {
			// registerCollection is not idempotent on the Hub — the second call in
			// the SAME room throws "already registered". Treat that as success so
			// this demo step can be re-run safely, matching legal-agent's own
			// `hub-db-object-store.ts` schema-registration handling.
			const message = error instanceof Error ? error.message : String(error);
			if (/already registered/i.test(message)) return { registered: true, alreadyRegistered: true };
			throw error;
		}
	}

	if (args.action === 'create') {
		const label = args.label?.trim();
		if (!label) throw new Error('label is required to create a record');
		const data = { label, note: args.note?.trim() || '' };
		return (await callAppPlatformTool(
			'mcpapp.db.create',
			{ collection: DEMO_COLLECTION, data },
			'db:write',
			roomId,
		)) as Record<string, unknown>;
	}

	if (args.action === 'query') {
		return (await callAppPlatformTool(
			'mcpapp.db.query',
			{ collection: DEMO_COLLECTION, orderBy: [{ field: '_createdAt', direction: 'desc' }], limit: 20 },
			'db:read',
			roomId,
		)) as Record<string, unknown>;
	}

	if (args.action === 'getSchema') {
		return (await callAppPlatformTool(
			'mcpapp.db.getSchema',
			{ collection: DEMO_COLLECTION },
			'db:schema:read',
			roomId,
		)) as Record<string, unknown>;
	}

	throw new Error(`Unknown action: ${(args as { action?: string }).action ?? '<missing>'}`);
}
