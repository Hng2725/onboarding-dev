/**
 * Caller binding for every tool that acts with this app's own bot credential.
 *
 * That credential has no per-user room boundary at the Hub, so the only thing
 * standing between "verified caller in room A" and "reads or writes room B's
 * app data" is this check. The room therefore comes from the verified actor,
 * never from tool arguments; an argument may only repeat it.
 */
import { INVALID_PARAMS, type VerifiedActor } from '@privos_ai/app-server';

function denied(message: string, code: string): Error {
	return Object.assign(new Error(message), { code: INVALID_PARAMS, data: { code } });
}

/** Fail closed unless the call carries an SDK-verified actor. */
export function requireVerifiedActor(actor: VerifiedActor | undefined): VerifiedActor {
	if (!actor) throw denied('Request denied: a verified user identity is required.', 'IDENTITY_REQUIRED');
	return actor;
}

/**
 * The room a bot-credential call may act in: the verified actor's own room.
 * A `roomId` argument is optional; when present it must equal that room.
 */
export function resolveCallerRoom(actor: VerifiedActor | undefined, requestedRoomId?: unknown): string {
	const verified = requireVerifiedActor(actor);
	const callerRoom = verified.roomId?.trim();
	if (!callerRoom) throw denied('Request denied: the verified identity is not bound to a room.', 'ROOM_UNBOUND');
	const requested = typeof requestedRoomId === 'string' ? requestedRoomId.trim() : '';
	if (requested && requested !== callerRoom) {
		throw denied('Request denied: roomId does not match the room this call was made from.', 'ROOM_FORBIDDEN');
	}
	return callerRoom;
}
