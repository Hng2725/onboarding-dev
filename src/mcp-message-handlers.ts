/**
 * MCP JSON-RPC method handlers for the PrivOS Onboarding app.
 * Production serves one self-contained HTML resource. Keeping JS and CSS in
 * that response avoids Hub generation caches pinning old content-hashed asset
 * names after a UI-only rebuild. Development still uses the live Vite server.
 */
import { createManifest } from './manifest';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
	INVALID_PARAMS,
	type UiResourceProvider,
	type VerifiedActor,
} from '@privos_ai/app-server';

import _pkg from '../privos-app.json';
import { getAppIconDataUri } from './app-icon';
import { serveInlineBuiltUi, type InlineBuiltUi } from './inline-ui';
import {
	DATA_TOOL_NAMES,
	handleOnboardingTool,
	ONBOARDING_DASHBOARD_TOOL,
	type OnboardingToolHandler,
} from './onboarding/tools';
const pkg = _pkg as Record<string, any>;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Stable logical URI from the reviewed manifest. The document itself is
 * self-contained, so UI-only rebuilds do not change this address or create
 * generation-pinned asset URLs.
 */
const UI_RESOURCE_URI = `ui://${pkg.name}/form.html`;

const appIcon = getAppIconDataUri();

/** Construct lazily so importing backend-only handlers does not require a UI build. */
let builtUi: InlineBuiltUi | null = null;
function getBuiltUi(): InlineBuiltUi {
	if (!builtUi) builtUi = serveInlineBuiltUi(path.join(moduleDir, '../dist/ui'));
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
 * The SDK runtime owns `initialize` and intercepts UI `resources/read` calls
 * before the application handler. Supplying this provider is therefore what
 * makes the manifest's `ui.resourceUri` discoverable at runtime; keeping the
 * callbacks lazy also lets tests import the handler before `dist/ui` exists.
 */
export const onboardingUiResource: UiResourceProvider = {
	uri: UI_RESOURCE_URI,
	mimeType: 'text/html;profile=mcp-app',
	renderHtml: () => currentShellHtml(),
};

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
	onboardingHandler: OnboardingToolHandler = handleOnboardingTool,
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
			if ((DATA_TOOL_NAMES as readonly string[]).includes(params?.name)) {
				const result = await onboardingHandler(params.name, params?.arguments ?? {}, actor);
				return { content: [{ type: 'text', text: JSON.stringify(result) }] };
			}
			if (params?.name !== ONBOARDING_DASHBOARD_TOOL) {
				throw Object.assign(new Error(`Unknown tool: ${params?.name || '<missing>'}`), {
					code: INVALID_PARAMS,
					data: { code: 'TOOL_NOT_FOUND' },
				});
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
 * Production exposes only the self-contained shell URI; stale split-asset
 * requests are rejected. Dev mode keeps forwarding requests to its live Vite
 * shell because those URLs exist only for the lifetime of the dev server.
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


	throw Object.assign(new Error(`Unknown resource: ${typeof uri === 'string' ? uri : '<missing>'}`), {
		code: INVALID_PARAMS,
	});
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
	  <title>${pkg.title || 'PrivOS Onboarding'} (dev)</title>
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
