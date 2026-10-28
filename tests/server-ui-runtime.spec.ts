import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

let child: ChildProcess | undefined;

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a test port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the development server.');
}

afterEach(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
  child = undefined;
});

describe('server UI runtime wiring', () => {
  it('advertises and serves the manifest UI resource through the SDK runtime', async () => {
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        HTTP_PORT: String(port),
        PRIVOS_TRANSPORT: '',
        PRIVOS_DEV_UI: '0',
        PRIVOS_STANDALONE_IDENTITY_FILE: path.join(path.resolve('.'), '.missing-test-identity.json'),
      },
      stdio: 'ignore',
    });
    await waitForHealth(origin);

    const initializeResponse = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const initialized = await initializeResponse.json() as any;
    expect(initialized.result.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes)
      .toEqual(['text/html;profile=mcp-app']);

    const uiUri = 'ui://ai.privos.mcp-app-onboarding-dev/form.html';
    const resourceResponse = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: uiUri } }),
    });
    const resource = await resourceResponse.json() as any;
    expect(resource.result.contents[0]).toMatchObject({
      uri: uiUri,
      mimeType: 'text/html;profile=mcp-app',
    });
    expect(resource.result.contents[0].text).toContain('<title>PrivOS Onboarding</title>');
  }, 15_000);
});
