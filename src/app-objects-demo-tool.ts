/**
 * Backend handler for the `hr_app_object_store` tool — demonstrates the
 * `mcpapp.objects.*` App Objects (CAS) MCP tools introduced in the Step-1
 * generic platform contract (merged hub `bff01ee8`, live only on
 * tenant.132+).
 *
 * Content-addressed, immutable, room-private objects: `put` computes the
 * sha256 digest of the given bytes itself and sends it as `sha256:<64hex>`
 * (the Hub independently re-verifies content == digest and rejects a
 * mismatch), `head` reads metadata only, `get` reads metadata + the bytes
 * back and re-verifies the digest here too, end to end.
 *
 * Runs with this app's OWN installation-bot credential (never the current
 * user's), via `POST /api/v1/mcp-apps.tool-call` — see
 * `app-platform-tool-call.ts`.
 */
import crypto from 'node:crypto';

import type { VerifiedActor } from '@privos_ai/app-server';

import { callAppPlatformTool } from './app-platform-tool-call';
import { resolveCallerRoom } from './caller-room';

export interface AppObjectStoreArgs {
	action: 'put' | 'head' | 'get';
	/** Optional: when present it must equal the verified caller's room. */
	roomId?: string;
	dataBase64?: string;
	mediaType?: string;
	digest?: string;
}

interface ObjectMetadata {
	digest: string;
	size: number;
	mediaType: string;
	createdAt: string;
	adopted: boolean;
}

function sha256Digest(bytes: Buffer): string {
	return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export async function handleAppObjectStoreTool(
	args: AppObjectStoreArgs,
	actor: VerifiedActor | undefined,
): Promise<Record<string, unknown>> {
	const roomId = resolveCallerRoom(actor, args.roomId);

	if (args.action === 'put') {
		const dataBase64 = args.dataBase64;
		const mediaType = args.mediaType?.trim();
		if (!dataBase64) throw new Error('dataBase64 is required to put an object');
		if (!mediaType) throw new Error('mediaType is required to put an object');
		const digest = sha256Digest(Buffer.from(dataBase64, 'base64'));
		const result = (await callAppPlatformTool(
			'mcpapp.objects.put',
			{ digest, dataBase64, mediaType },
			'db:write',
			roomId,
		)) as ObjectMetadata;
		return { ...result, requestDigest: digest };
	}

	const digest = args.digest?.trim();
	if (!digest) throw new Error('digest is required');

	if (args.action === 'head') {
		return (await callAppPlatformTool('mcpapp.objects.head', { digest }, 'db:read', roomId)) as Record<string, unknown>;
	}

	if (args.action === 'get') {
		const result = (await callAppPlatformTool('mcpapp.objects.get', { digest }, 'db:read', roomId)) as ObjectMetadata & {
			dataBase64: string;
		};
		const verifiedDigest = sha256Digest(Buffer.from(result.dataBase64, 'base64'));
		return { ...result, digestVerifiedLocally: verifiedDigest === result.digest };
	}

	throw new Error(`Unknown action: ${(args as { action?: string }).action ?? '<missing>'}`);
}
