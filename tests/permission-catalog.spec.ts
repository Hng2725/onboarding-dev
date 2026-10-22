import { describe, expect, it } from 'vitest';

import manifest from '../privos-app.json';

/**
 * Local mirror of the Portal's versioned permission catalog
 * (`privos-portal/src/services/marketplace/marketplace-mcp-permission-catalog.ts`,
 * MCP_PERMISSION_CATALOG_VERSION = '2026-08-31'), restricted to the scopes this
 * app declares. It exists so a bad edit to `privos-app.json` fails HERE instead
 * of at Portal submit time as `PROPOSAL_PERMISSION_UNKNOWN` /
 * `PROPOSAL_PERMISSION_CONTEXT_INVALID` / `PROPOSAL_PERMISSION_EXECUTION_INVALID`.
 *
 * If this app declares a NEW scope, add it here only after confirming its
 * allowed `contexts` / `executionContexts` against the live Portal catalog — an
 * unlisted scope is treated as unknown and fails, which is the intended signal.
 */
type PermissionContext = 'workspace' | 'room';
type ExecutionContext = 'user' | 'background' | 'both';

type CatalogEntry = {
	contexts: readonly PermissionContext[];
	executionContexts: readonly ExecutionContext[];
};

const CATALOG: Readonly<Record<string, CatalogEntry>> = {
	'basic:information': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'rooms:roles:read': { contexts: ['room'], executionContexts: ['user'] },
	'rooms:read': { contexts: ['room'], executionContexts: ['user'] },
	'lists:read': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'lists:query': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'lists:write': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'custom-permissions:read': { contexts: ['room'], executionContexts: ['user', 'background', 'both'] },
	'custom-permissions:write': { contexts: ['room'], executionContexts: ['user', 'background', 'both'] },
	'users:read': { contexts: ['workspace', 'room'], executionContexts: ['user'] },
	'notifications:write': { contexts: ['room'], executionContexts: ['user', 'background', 'both'] },
	'files:read': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'files:write': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'bot:room:join': { contexts: ['room'], executionContexts: ['user'] },
	'bot:identity:read': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:generate': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:skills:use': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:botkey:push': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:wake': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:ai-chat': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:ai-chat:write': { contexts: ['room'], executionContexts: ['user'] },
	'sandbox:agent-sets:upload': { contexts: ['workspace'], executionContexts: ['user'] },
	// Step-1 generic platform contract (merged hub bff01ee8): userAndBackground in the hub's own
	// mcp-permission-catalog.ts.
	'db:read': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'db:write': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'db:schema:read': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
	'db:schema:write': { contexts: ['workspace', 'room'], executionContexts: ['user', 'background', 'both'] },
};

/**
 * Scopes the Portal catalog has RETIRED. They still work for already-installed
 * copies but reject every NEW submission that requests them, so nothing in the
 * running fleet warns you — the test is the only guard. `bot:agent:create` was
 * retired when creating the installation bot became an administrator action.
 */
const RETIRED_SCOPES: ReadonlySet<string> = new Set(['bot:agent:create']);

/** Mirrors the Portal's `assertCatalogPermission`. */
function assertCatalogPermission(input: { scope: string; context: PermissionContext; executionContext: ExecutionContext }): void {
	const entry = CATALOG[input.scope];
	expect(entry, `scope not in catalog (or retired): ${input.scope}`).toBeDefined();
	expect(entry!.contexts, `context '${input.context}' invalid for ${input.scope}`).toContain(input.context);
	const requested = input.executionContext === 'both' ? (['user', 'background'] as const) : ([input.executionContext] as const);
	for (const context of requested) {
		expect(entry!.executionContexts, `executionContext '${input.executionContext}' invalid for ${input.scope}`).toContain(context);
	}
}

describe('marketplace permission-catalog conformance', () => {
	const permissions = (manifest as { permissions: Array<{ scope: string; context: PermissionContext; executionContext: ExecutionContext }> }).permissions;

	it('declares at least one permission', () => {
		expect(permissions.length).toBeGreaterThan(0);
	});

	it('declares no retired scope', () => {
		for (const permission of permissions) {
			expect(RETIRED_SCOPES.has(permission.scope), `retired scope declared: ${permission.scope}`).toBe(false);
		}
	});

	it('every declared permission passes the catalog context/execution rules', () => {
		for (const permission of permissions) {
			assertCatalogPermission(permission);
		}
	});

	it('declares no duplicate scope', () => {
		const scopes = permissions.map((permission) => permission.scope);
		expect(new Set(scopes).size).toBe(scopes.length);
	});
});
