import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import appManifest from '../privos-app.json';
import { handleMcpMessage } from '../src/mcp-message-handlers';

const uiTool = (appManifest.tools as { name: string; ui?: { resourceUri?: string } }[])
  .find((tool) => tool.name === 'onboarding_dashboard');
const UI_RESOURCE_URI = uiTool!.ui!.resourceUri!;
const ASSETS_MANIFEST_URI = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets-manifest.json`;

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

describe('new onboarding UI source tree', () => {
  it('contains no legacy demo UI files or labels', () => {
    const files = sourceFiles(path.resolve('src/ui'));
    const relative = files.map((file) => path.relative(path.resolve('src/ui'), file).replaceAll('\\', '/'));
    const source = files.filter((file) => /\.(ts|tsx|css|html)$/.test(file)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    expect(relative).not.toEqual(expect.arrayContaining([
      'contact-collector-form.tsx', 'app-db-panel.tsx', 'app-objects-panel.tsx',
      'agent-bot-panel.tsx', 'sample-agent-set.tar.gz', 'panels/ai-chat-panel.tsx',
    ]));
    expect(source).toContain('onboarding_bootstrap');
    expect(source).toContain('PrivOS Onboarding');
    expect(source).not.toContain('hr_management_dashboard');
    expect(source).not.toContain('App Database demo');
    expect(source).not.toContain('AI Poem');
  });
});

describe('built onboarding UI shell', () => {
  beforeAll(() => {
    const viteBin = path.resolve('node_modules/vite/bin/vite.js');
    const result = spawnSync(process.execPath, [viteBin, 'build'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`vite build failed:\n${result.stdout}\n${result.stderr}`);
  });

  it('keeps the ui host equal to the registered app id', () => {
    expect(new URL(UI_RESOURCE_URI).host).toBe(appManifest.name);
  });

  it('serves a self-contained onboarding shell with an inline boot watchdog', async () => {
    const result = await handleMcpMessage('resources/read', 1, { uri: UI_RESOURCE_URI });
    const html = result.contents[0].text as string;

    expect(html).toContain('<meta name="privos-ui-assets" content="inline">');
    expect(html).toContain('__privosUiBooted');
    expect(html).toContain('ui/app-boot-failed');
    expect(html).toContain('<title>PrivOS Onboarding</title>');
    expect(html).toContain('<style>');
    expect(html).toMatch(/<script\b[^>]*type=["']module["'][^>]*>/i);
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']\.?\/?assets\//i);
  });

  it('keeps legacy demo code out of the delivered document', async () => {
    const result = await handleMcpMessage('resources/read', 2, { uri: UI_RESOURCE_URI });
    const html = result.contents[0].text as string;

    for (const legacy of ['hr_management_dashboard', 'hr_app_db_store', 'AI Poem', 'Isolated ASSIGNEE']) {
      expect(html).not.toContain(legacy);
    }
  });

  it('returns the same self-contained shell from the dashboard tool', async () => {
    const viaResource = await handleMcpMessage('resources/read', 3, { uri: UI_RESOURCE_URI });
    const viaTool = await handleMcpMessage('tools/call', 4, { name: 'onboarding_dashboard', arguments: {} });
    expect(viaTool.content[0].resource.text).toBe(viaResource.contents[0].text);
  });

  it('refuses stale split-asset resources', async () => {
    const unknown = await handleMcpMessage('resources/read', 5, { uri: ASSETS_MANIFEST_URI })
      .catch((error: Error & { code?: number }) => error);
    expect(unknown).toMatchObject({ code: -32602 });
  });
});
