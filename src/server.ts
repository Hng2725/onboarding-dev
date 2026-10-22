/**
 * Entry point. `serveApp` resolves exactly one of `managed` / `runtime-v3` /
 * `standalone-production` / `development` (a valid driver `runtime-v3` env
 * wins; otherwise precedence managed > standalone-production > development; a
 * fatal `RuntimeModeError` when both a managed workload socket and a paired
 * standalone identity file are present, or when `NODE_ENV=production` has none
 * of them) and wires the correct transport + trust bootstrap + agent-bot hub
 * internally.
 *
 * The ONE piece that stays app-local (by design) is the interactive
 * `development` Relay loop: `PRIVOS_TRANSPORT=relay` (`npm run dev`) steps
 * `serveApp` aside from the Direct HTTP MCP router and runs the terminal
 * pairing prompt + optional Vite dev-UI here. `PRIVOS_TRANSPORT` is a
 * development affordance only — `serveApp` rejects `transportOverride` under any
 * production mode as a boot error.
 *
 * `/.well-known/mcp/manifest.json` is served from `createManifest()` (the exact
 * reviewed marketplace manifest, digest-pinned) via the `configure` hook, ahead
 * of the router, so the published manifest bytes never change.
 */
import 'dotenv/config';

import express from 'express';
import { serveApp, RuntimeModeError } from '@privos_ai/app-server';

import { createManifest, buildRelayAppDescriptor } from './manifest';
import { onboardingUiResource } from './mcp-message-handlers';
import { relayMcpHandler } from './relay-transport';

/**
 * Manifest-only degraded surface for `PRODUCTION_WITHOUT_IDENTITY`.
 *
 * The marketplace build node runs the built image bare — no workload socket, no
 * identity file — and requires it to serve `/.well-known/mcp/manifest.json`
 * (an image that cannot be discovered cannot be installed). serveApp correctly
 * refuses to run MCP in production without an identity, so in that state this
 * app serves ONLY the public reviewed manifest plus /health, with /ready held
 * at 503: no /mcp surface exists, dispatch stays fail-closed, and a real
 * production misconfiguration still turns the container unhealthy instead of
 * silently passing. `AMBIGUOUS_RUNTIME_IDENTITY` remains a hard exit — two
 * identities present is stale state an operator must resolve.
 */
function startManifestOnlySurface(reason: string): void {
	const port = Number(process.env.PORT || 3000);
	const app = express();
	app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
	app.get('/health', (_req, res) => res.status(200).json({ ok: true, status: 'alive', degraded: true }));
	app.get('/ready', (_req, res) => res.status(503).json({ ok: false, status: 'not_ready', reason: 'PRODUCTION_WITHOUT_IDENTITY' }));
	app.listen(port, '0.0.0.0', () => {
		console.error(`No runtime identity: ${reason}`);
		console.error(`Serving the manifest only on :${port} — no MCP surface until a workload socket or paired identity file is present.`);
	});
}

async function start(): Promise<void> {
	const transportOverride = process.env.PRIVOS_TRANSPORT === 'relay' ? ('relay' as const) : undefined;

	const handle = await serveApp({
		descriptor: buildRelayAppDescriptor(),
		ui: onboardingUiResource,
		createHandler: () => relayMcpHandler,
		port: Number(process.env.PORT || 3000),
		...(transportOverride ? { transportOverride } : {}),
		resolveManifest: () => createManifest(),
		configure: (app) => {
			// Serve the authoritative reviewed manifest verbatim, before the MCP
			// router's own manifest route, so the digest-pinned bytes are exact.
			app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
		},
	});

	// development + PRIVOS_TRANSPORT=relay: run the app-local pairing loop (and
	// optional live Vite dev UI) alongside serveApp's HTTP support surface.
	if (handle.mode === 'development' && transportOverride === 'relay') {
		if (process.env.PRIVOS_DEV_UI === '1') {
			const { startDevUiServer } = await import('./dev-server');
			const { setDevPublicUrl } = await import('./mcp-message-handlers');
			const dev = await startDevUiServer();
			setDevPublicUrl(dev.publicUrl);
		}
		const { startDevelopmentRelay } = await import('./relay-transport');
		await startDevelopmentRelay();
	}
}

start().catch((err) => {
	if (err instanceof RuntimeModeError && err.code === 'PRODUCTION_WITHOUT_IDENTITY') {
		startManifestOnlySurface(err.message);
		return;
	}
	console.error('Failed to start:', err instanceof Error ? err.message : err);
	process.exit(1);
});
