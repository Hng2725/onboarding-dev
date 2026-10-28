import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';
import publisherManifest from '../privos-app.json';
import { createManifest, MARKETPLACE_MANIFEST_FIELDS } from '../src/manifest';
import { lintManifest } from '@privos_ai/app-server/manifest-tools';

describe('manifest', () => {
  it('serves the canonical Marketplace manifest', () => {
    const manifest = createManifest();
    expect(Object.keys(manifest)).toEqual(MARKETPLACE_MANIFEST_FIELDS);
    expect(manifest).toEqual(publisherManifest);
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.title).toBe(pkg.title);
    expect(manifest.repository).toBe(pkg.repository.url);
  });

  it('passes strict manifest lint and emits deterministic canonical hashes', () => {
    const report = lintManifest(createManifest());
    expect(report.valid, report.errors.join('; ')).toBe(true);
    expect(report.canonicalManifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.publisherPermissionDeclarationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('describes the onboarding product, tools, resource, and degraded notification behavior', () => {
    const manifest = createManifest();
    expect(manifest.description).toContain('Onboard room members');
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      'onboarding_dashboard',
      'onboarding_bootstrap',
      'onboarding_admin_templates',
      'onboarding_admin_ai',
      'onboarding_admin_assignments',
      'onboarding_learning',
      'onboarding_reviews',
    ]);
    expect(manifest.tools[0].ui?.resourceUri).toBe('ui://ai.privos.mcp-app-onboarding-dev/form.html');
    expect(manifest.permissions.map((permission) => permission.scope)).toEqual([
      'basic:information', 'bot:room:join', 'rooms:roles:read', 'rooms:read', 'notifications:write', 'files:read', 'files:write',
      'sandbox:generate', 'sandbox:ai-chat', 'sandbox:ai-chat:write',
      'db:read', 'db:write', 'db:schema:read', 'db:schema:write',
    ]);
    expect(manifest.permissions.find((permission) => permission.scope === 'bot:room:join')).toMatchObject({
      requirement: 'required',
      context: 'room',
      executionContext: 'user',
    });
    expect(manifest.permissions.find((permission) => permission.scope === 'notifications:write')?.degradedBehavior)
      .toContain('remain saved');
    expect(manifest.permissions.find((permission) => permission.scope === 'sandbox:generate')).toMatchObject({
      requirement: 'optional',
      context: 'room',
      executionContext: 'user',
      degradedBehavior: expect.stringContaining('cannot create'),
    });
    expect(manifest.permissions.find((permission) => permission.scope === 'sandbox:ai-chat')).toMatchObject({
      requirement: 'optional',
      context: 'room',
      executionContext: 'user',
    });
    expect(manifest.permissions.find((permission) => permission.scope === 'sandbox:ai-chat:write')).toMatchObject({
      requirement: 'optional',
      context: 'room',
      executionContext: 'user',
    });
    expect(JSON.stringify(manifest)).not.toContain('hr_');
    expect(JSON.stringify(manifest)).not.toContain('demo tab');
  });

  it('contains only onboarding product metadata and no legacy backend modules', () => {
    expect(pkg.description.toLowerCase()).toContain('onboard');
    expect(pkg.keywords).toContain('onboarding');
    expect(pkg.keywords).not.toContain('demo');
    expect(pkg.repository.url).toBe('https://github.com/Hng2725/onboarding-dev.git');
    for (const file of [
      'src/agent-bot-credential-check.ts',
      'src/app-db-demo-tool.ts',
      'src/app-objects-demo-tool.ts',
      'src/app-platform-demo-tool-defs.ts',
      'src/license.ts',
    ]) {
      expect(fs.existsSync(path.resolve(file)), `${file} must be removed`).toBe(false);
    }
  });
});
