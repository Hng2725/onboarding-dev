/**
 * MCP JSON-RPC method handlers for the relay demo app.
 * Production: the shell (`builtUi.renderHtml()`) and its hashed `assets/`
 * files are split over separate `resources/read` calls — the Hub fetches
 * assets once per installation generation and re-serves them from its own
 * origin, so the same 250 KB bundle no longer travels the relay on every tab
 * open. In development: reads source and builds on-the-fly via Vite.
 */
import { createManifest } from './manifest';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
	getPlatformContext,
	publicUrlFor,
	serveBuiltUi,
	INVALID_PARAMS,
	type ServeBuiltUi,
	type VerifiedActor,
} from '@privos_ai/app-server';

import _pkg from '../privos-app.json';
import { getAppIconDataUri } from './app-icon';
import { createLicenseGuard } from './license';
import { checkAgentBotCredential } from './agent-bot-credential-check';
import { APP_OBJECT_STORE_TOOL, APP_DB_STORE_TOOL, APP_PLATFORM_TOOL_DEFINITIONS } from './app-platform-demo-tool-defs';
import { handleAppObjectStoreTool } from './app-objects-demo-tool';
import { handleAppDbStoreTool } from './app-db-demo-tool';
import { requireVerifiedActor } from './caller-room';
const pkg = _pkg as Record<string, any>;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = 'hr_management_dashboard';
// Pure data (no UI) tool: returns the SDK-verified caller actor — Managed Direct
// HTTP names it in the body-bound Hub dispatch assertion; Relay names it via a
// separately Hub-signed user token verified against the Hub's JWKS. See
// `handleWhoami` and `handleMcpMessage`'s `actor` parameter doc below.
const WHOAMI_TOOL = 'hr_whoami';
const BULK_EXPORT_TOOL = 'hr_bulk_export';
// Pure data (no UI) tool: proves the configured agent bot credential actually
// authenticates against the Hub. See agent-bot-credential-check.ts.
const CREDENTIAL_CHECK_TOOL = 'hr_agent_bot_credential_check';
/**
 * `ui://<appSlug>/…` — `appSlug` MUST be `app.appId`, i.e. `privos-app.json`'s `name`
 * (`ai.privos.mcp-app-demo`), never a different, human-friendlier host string. The Hub resolves
 * `serveBuiltUi`'s asset/manifest URIs from the registered app id, not from this resource URI —
 * a mismatch here 404s every asset behind a correct-looking "App assets unavailable" watchdog.
 */
const UI_RESOURCE_URI = `ui://${pkg.name}/form.html`;
/** `appSlug` for `serveBuiltUi` — must equal `app.appId` (`privos-app.json`'s `name`). Derived from
 * {@link UI_RESOURCE_URI}'s host so the two can never drift apart again. */
const UI_APP_SLUG = new URL(UI_RESOURCE_URI).host;
/** Sits beside {@link UI_RESOURCE_URI}, not under the `assets/` prefix — matches the SDK's own convention. */
const ASSETS_MANIFEST_URI = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets-manifest.json`;

/**
 * Embed origins this app declares, read straight from the published manifest so the runtime
 * advertisement and the marketplace listing can never disagree about what was requested.
 */
const UI_DECLARED_CSP: Record<string, string[]> | undefined = (pkg.tools as any[] | undefined)?.find(
	(tool) => tool?.ui?.resourceUri === UI_RESOURCE_URI,
)?.ui?.csp;

const appIcon = getAppIconDataUri();

/**
 * Built once, lazily: constructing before `dist/ui` exists (e.g. `npm test`
 * runs ahead of `npm run build` in `verify:fast-pr`) must not crash every
 * caller that merely imports this module. `serveBuiltUi` throws at
 * construction on a malformed build (non-relative asset tags, unhashed/
 * oversized/`.map` files under `assets/`) — that failure surfaces the first
 * time the UI is actually requested, never earlier.
 */
let builtUi: ServeBuiltUi | null = null;
function getBuiltUi(): ServeBuiltUi {
	if (!builtUi) {
		builtUi = serveBuiltUi({ distDir: path.join(moduleDir, '../dist/ui'), appSlug: UI_APP_SLUG });
	}
	return builtUi;
}

/**
 * When set, the UI is served live from a Vite dev server at this public origin
 * (HMR + breakpoints) instead of the split production bundle. See dev-server.ts.
 */
let devPublicUrl: string | null = null;

/** Enable dev mode: iframe loads UI from the Vite dev server at `publicUrl`. */
export function setDevPublicUrl(publicUrl: string): void {
	devPublicUrl = publicUrl.replace(/\/$/, '');
}

/** The shell HTML for the current mode — live dev server, or the built-and-cached production shell. */
function currentShellHtml(): string {
	return devPublicUrl ? getDevUiHtml(devPublicUrl) : getBuiltUi().renderHtml();
}

/**
 * Handle an incoming MCP JSON-RPC request and return the result.
 *
 * `actor` is the SDK's unified {@link VerifiedActor} — the same shape for
 * both transports, distinguished only by `actor.provenance`:
 *   - `'dispatch-assertion'` — Managed Direct HTTP; the Hub embedded the
 *     actor claim directly in the body-bound Cluster dispatch assertion
 *     verified by `verifyInboundDispatch` before this call.
 *   - `'user-token'` — Relay (`standalone-production`, and `development`
 *     whenever a Hub dispatch trust is configured); the SDK independently
 *     verified a separate Hub-signed RS256 user JWT against the Hub's JWKS
 *     and cross-bound it to the already-verified dispatch `roomId`.
 * `undefined` means no verified caller identity is available for this
 * request (no token was presented, the token was invalid, or JWKS
 * verification failed) — callers must treat that as "unknown", never fall
 * back to any unverified out-of-band field.
 */
export async function handleMcpMessage(
	method: string,
	_id: number,
	params: any,
	actor?: VerifiedActor,
): Promise<any> {
	switch (method) {
		case 'initialize':
			return {
				protocolVersion: '2025-03-26',
				capabilities: {
					tools: {},
					extensions: {
						'io.modelcontextprotocol/ui': {
							mimeTypes: ['text/html;profile=mcp-app'],
						},
					},
				},
				serverInfo: {
				// `name` must equal the manifest name (the Hub compares it at readiness); the
				// human-readable title rides in MCP's optional `title`.
				name: pkg.name,
				title: pkg.title,
				version: pkg.version,
				...(appIcon && { icon: appIcon }),
				// Advertise the exact schema-v2 declaration; Hub owns catalog metadata
				// and still enforces the selected subset server-side.
				...(Array.isArray(pkg.permissions) && { permissions: pkg.permissions }),
			},
			};

		case 'notifications/initialized':
			return {};

		case 'tools/list':
			// The reviewed manifest is the one source of tool definitions: the Hub's readiness
			// check compares its tools against the served list after lifting `_meta.ui` to
			// `ui`, so each manifest entry is served with its `ui` under `_meta` and nothing else.
			return { tools: createManifest().tools.map(({ ui, ...tool }) => (ui ? { ...tool, _meta: { ui } } : tool)) };

		case 'tools/call':
			if (params?.name === BULK_EXPORT_TOOL) {
				requireVerifiedActor(actor);
				const records = Array.isArray(params?.arguments?.records) ? params.arguments.records : [];
				const guard = createLicenseGuard();
				guard.assert('bulk-export');
				guard.assertWithin('records', records.length);
				return { content: [{ type: 'text', text: JSON.stringify({ exported: records.length, records }) }] };
			}
			if (params?.name === WHOAMI_TOOL) {
				return handleWhoami(actor);
			}
			if (params?.name === CREDENTIAL_CHECK_TOOL) {
				return { content: [{ type: 'text', text: JSON.stringify(await checkAgentBotCredential()) }] };
			}
			if (params?.name === APP_OBJECT_STORE_TOOL) {
				return { content: [{ type: 'text', text: JSON.stringify(await handleAppObjectStoreTool(params?.arguments || {}, actor)) }] };
			}
			if (params?.name === APP_DB_STORE_TOOL) {
				return { content: [{ type: 'text', text: JSON.stringify(await handleAppDbStoreTool(params?.arguments || {}, actor)) }] };
			}
			if (params?.name !== TOOL_NAME) {
				throw new Error(`Unknown tool: ${params?.name || '<missing>'}`);
			}
			return {
				content: [
					{
						type: 'resource',
						resource: {
							uri: UI_RESOURCE_URI,
							mimeType: 'text/html;profile=mcp-app',
							text: currentShellHtml(),
						},
					},
				],
			};

		case 'resources/read':
			return handleResourcesRead(params?.uri);

		default:
			throw new Error(`Unknown method: ${method}`);
	}
}

/**
 * `resources/read` branches on the requested URI: the shell, the assets
 * manifest, or one split asset. Any other URI is refused — before the split,
 * this handler echoed the UI HTML for every URI it was asked about; that
 * silent fallback is gone by design (see the demo's CHANGELOG).
 *
 * Dev mode short-circuits ahead of all of this: the live Vite dev server is
 * the only source of truth there (no split assets exist to read), so it keeps
 * echoing the dev shell for whatever URI was requested, matching the
 * pre-split behavior exactly.
 */
function handleResourcesRead(uri: unknown): { contents: unknown[] } {
	if (devPublicUrl) {
		return {
			contents: [
				{
					uri: typeof uri === 'string' ? uri : UI_RESOURCE_URI,
					mimeType: 'text/html;profile=mcp-app',
					text: currentShellHtml(),
				},
			],
		};
	}

	if (uri === UI_RESOURCE_URI) {
		return { contents: [{ uri: UI_RESOURCE_URI, mimeType: 'text/html;profile=mcp-app', text: currentShellHtml() }] };
	}

	if (uri === ASSETS_MANIFEST_URI) {
		return {
			contents: [{ uri: ASSETS_MANIFEST_URI, mimeType: 'application/json', text: JSON.stringify(getBuiltUi().readAssetsManifest()) }],
		};
	}

	const asset = typeof uri === 'string' ? getBuiltUi().readAsset(uri) : null;
	if (asset) return { contents: [asset] };

	throw Object.assign(new Error(`Unknown resource: ${typeof uri === 'string' ? uri : '<missing>'}`), {
		code: INVALID_PARAMS,
	});
}

/**
 * Backend handler for the `hr_whoami` tool.
 *
 * `actor` is only ever the SDK-verified {@link VerifiedActor} the caller
 * (`http-server.ts` for Managed Direct HTTP, `relay-transport.ts` for Relay)
 * forwarded from `runtime-identity.ts` / `context.actor`. This function never
 * reads any plain, unverified caller-identity field (e.g. request
 * `_meta.privosUser.userId`) — those ride alongside the signed token but are
 * not proof of anything on their own, and there is intentionally no fallback
 * to them here. The iframe never receives or forwards a bearer/user token.
 */
async function handleWhoami(actor?: VerifiedActor): Promise<any> {
	const wrap = (obj: Record<string, any>) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
	if (!actor) {
		return wrap({
			verified: false,
			error: 'No verified caller identity is available for this request (no token presented, or verification failed).',
		});
	}
	const username = actor.username || actor.userId;
	return wrap({
		verified: true,
		username,
		userId: actor.userId,
		roomId: actor.roomId,
		provenance: actor.provenance,
		message: `Backend verified this request came from ${username} (${actor.userId}) via ${actor.provenance}.`,
		platform: describePlatformEnvironment(),
	});
}

/**
 * What the platform injected and what the operator configured — reported so an
 * end-to-end check can prove the environment actually reached the container.
 *
 * A secret is reported as SET or UNSET and never by value: this output travels
 * through the room, so printing the SMTP password — or the agent bot
 * credential — here would be exactly the leak the whole write-only path
 * exists to prevent. `PRIVOS_AGENT_BOT_CREDENTIAL` is written by a workspace
 * admin from Admin > Apps > this app > Settings, never by this app; this
 * backend only ever reads it from its own environment, the same as any other
 * declared secret.
 */
function describePlatformEnvironment(): Record<string, unknown> {
	const platform = getPlatformContext();
	return {
		publicUrl: platform.publicUrl ?? null,
		accessMode: platform.accessMode ?? null,
		mediaUrlExample: publicUrlFor('/public/icon.svg') ?? null,
		companyName: process.env.HRM_COMPANY_NAME ?? null,
		locale: process.env.HRM_LOCALE ?? 'en-US',
		smtpPasswordSet: Boolean(process.env.HRM_SMTP_PASSWORD),
		agentBotCredentialSet: Boolean(process.env.PRIVOS_AGENT_BOT_CREDENTIAL),
	};
}

/**
 * Build HTML referencing a live Vite dev server (HMR + TypeScript breakpoints).
 * Loads @vite/client and the React Fast Refresh preamble cross-origin from the
 * tunnel, then the real entry module — equivalent to what Vite injects into a
 * transformed index.html, but emitted here since the relay serves the document.
 */
function getDevUiHtml(publicUrl: string): string {
	const base = `${publicUrl}/ui`;
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
	  <title>${pkg.title || 'PrivOS Demo MCP App'} (dev)</title>
  <script type="module" src="${base}/@vite/client"></script>
  <script type="module">
    import RefreshRuntime from "${base}/@react-refresh";
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${base}/main.tsx"></script>
</body>
</html>`;
}
