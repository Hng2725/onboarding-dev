import { afterEach, describe, expect, it } from 'vitest';
import type { VerifiedActor } from '@privos_ai/app-server';
import { handleMcpMessage } from '../src/mcp-message-handlers';

function callerIn(roomId: string): VerifiedActor {
  return { userId: 'user-1', username: 'alice', roomId, claims: Object.freeze({}), provenance: 'user-token' };
}

describe('JSON-RPC handlers', () => {
  afterEach(() => {
    delete process.env.PRIVOS_AGENT_BOT_CREDENTIAL;
    delete process.env.PRIVOS_AGENT_BOT_USER_ID;
  });

  it('initializes and lists tools', async () => {
    expect((await handleMcpMessage('initialize', 1, {})).serverInfo.name).toBeTruthy();
    const listed = await handleMcpMessage('tools/list', 2, {});
    expect(listed.tools.map((tool: any) => tool.name)).toContain('hr_bulk_export');
    expect(listed.tools.map((tool: any) => tool.name)).toContain('hr_agent_bot_credential_check');
    expect(listed.tools.map((tool: any) => tool.name)).toContain('hr_app_object_store');
    expect(listed.tools.map((tool: any) => tool.name)).toContain('hr_app_db_store');
    const whoami = listed.tools.find((tool: any) => tool.name === 'hr_whoami');
    expect(whoami.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('validates hr_app_object_store arguments before ever calling the Hub', async () => {
    const missingData = await handleMcpMessage(
      'tools/call',
      6,
      { name: 'hr_app_object_store', arguments: { action: 'put', mediaType: 'text/plain' } },
      callerIn('room-1'),
    ).catch((err: Error) => err);
    expect(missingData).toBeInstanceOf(Error);
    expect((missingData as Error).message).toContain('dataBase64 is required');

    const missingDigest = await handleMcpMessage(
      'tools/call',
      7,
      { name: 'hr_app_object_store', arguments: { action: 'get', roomId: 'room-1' } },
      callerIn('room-1'),
    ).catch((err: Error) => err);
    expect(missingDigest).toBeInstanceOf(Error);
    expect((missingDigest as Error).message).toContain('digest is required');
  });

  it('validates hr_app_db_store arguments before ever calling the Hub', async () => {
    const missingLabel = await handleMcpMessage(
      'tools/call',
      9,
      { name: 'hr_app_db_store', arguments: { action: 'create', roomId: 'room-1' } },
      callerIn('room-1'),
    ).catch((err: Error) => err);
    expect(missingLabel).toBeInstanceOf(Error);
    expect((missingLabel as Error).message).toContain('label is required');
  });

  it('routes hr_agent_bot_credential_check to the credential self-check, reporting absent env as not-configured', async () => {
    const result = await handleMcpMessage('tools/call', 5, { name: 'hr_agent_bot_credential_check', arguments: {} });
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'not-configured' });
  });

  it('uses only a verified actor for backend identity, regardless of transport', async () => {
    const unverified = await handleMcpMessage('tools/call', 3, { name: 'hr_whoami', arguments: {} });
    expect(JSON.parse(unverified.content[0].text)).toMatchObject({ verified: false });

    // Managed Direct HTTP: actor came from the Hub-embedded dispatch-assertion claim.
    const verifiedManaged = await handleMcpMessage(
      'tools/call',
      4,
      { name: 'hr_whoami', arguments: { userToken: 'ignored-browser-secret' } },
      { userId: 'user-1', username: 'alice', roomId: 'room-1', claims: Object.freeze({}), provenance: 'dispatch-assertion' },
    );
    expect(JSON.parse(verifiedManaged.content[0].text)).toMatchObject({
      verified: true,
      userId: 'user-1',
      username: 'alice',
      roomId: 'room-1',
      provenance: 'dispatch-assertion',
    });
    expect(verifiedManaged.content[0].text).not.toContain('ignored-browser-secret');

    // Relay: actor came from a separately Hub-signed user token verified against the Hub JWKS.
    const verifiedRelay = await handleMcpMessage(
      'tools/call',
      5,
      { name: 'hr_whoami', arguments: {} },
      { userId: 'user-2', username: 'bob', roomId: 'room-2', claims: Object.freeze({ sub: 'user-2' }), provenance: 'user-token' },
    );
    expect(JSON.parse(verifiedRelay.content[0].text)).toMatchObject({
      verified: true,
      userId: 'user-2',
      username: 'bob',
      roomId: 'room-2',
      provenance: 'user-token',
    });
  });
  it('calls the licensed tool on Pro', async () => {
    process.env.PRIVOS_APP_LICENSE = '{"tier":"pro","state":"active"}';
    const result = await handleMcpMessage('tools/call', 3, {
      name: 'hr_bulk_export', arguments: { records: [{ id: 1 }] },
    }, callerIn('room-1'));
    delete process.env.PRIVOS_APP_LICENSE;
    expect(JSON.parse(result.content[0].text).exported).toBe(1);
  });
});
