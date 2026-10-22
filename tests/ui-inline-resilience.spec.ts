import { describe, expect, it } from 'vitest';

import appManifest from '../privos-app.json';
import { handleMcpMessage, onboardingUiResource } from '../src/mcp-message-handlers';

const uiTool = (appManifest.tools as { name: string; ui?: { resourceUri?: string } }[])
  .find((tool) => tool.name === 'onboarding_dashboard');
const UI_RESOURCE_URI = uiTool!.ui!.resourceUri!;
const ASSETS_MANIFEST_URI = `${UI_RESOURCE_URI.slice(0, UI_RESOURCE_URI.lastIndexOf('/') + 1)}assets-manifest.json`;

describe('generation-independent UI delivery', () => {
  it('serves one self-contained HTML document without generation-cached asset requests', async () => {
    const result = await handleMcpMessage('resources/read', 1, { uri: UI_RESOURCE_URI });
    const html = result.contents[0].text as string;

    expect(onboardingUiResource.readAsset).toBeUndefined();
    expect(onboardingUiResource.readAssetsManifest).toBeUndefined();
    expect(onboardingUiResource.assetUriPrefix).toBeUndefined();
    expect(html).toContain('<style>');
    expect(html).toMatch(/<script\b[^>]*type=["']module["'][^>]*>/i);
    expect(html).not.toContain('name="privos-ui-assets" content="relay"');
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']\.?\/?assets\//i);
    expect(html).not.toMatch(/\bimport\s*(?:\(|[^"']*from\s*)["']\.?\/?assets\//i);
  });

  it('does not advertise a split assets manifest that Hub could pin to a pairing generation', async () => {
    const result = await handleMcpMessage('resources/read', 2, { uri: ASSETS_MANIFEST_URI })
      .catch((error: Error & { code?: number }) => error);

    expect(result).toMatchObject({ code: -32602 });
  });
});
