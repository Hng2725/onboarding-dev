import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/ui/onboarding/styles.css', import.meta.url)),
  'utf8',
);
const templateEditorStylesheet = readFileSync(
  fileURLToPath(new URL('../src/ui/onboarding/template-editor.css', import.meta.url)),
  'utf8',
);

function declarations(block: string): ReadonlyMap<string, string> {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
      .map((match) => [match[1], match[2].trim()] as const),
  );
}

function themeBlock(pattern: RegExp): ReadonlyMap<string, string> {
  const block = stylesheet.match(pattern)?.[1];
  if (!block) throw new Error(`Theme block not found: ${pattern}`);
  return declarations(block);
}

function cssRule(pattern: RegExp, source = templateEditorStylesheet): ReadonlyMap<string, string> {
  const block = source.match(pattern)?.[1] ?? '';
  return new Map(
    [...block.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
      .map((match) => [match[1], match[2].trim()] as const),
  );
}

function resolveThemeColor(value: string, theme: ReadonlyMap<string, string>): string {
  const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return token ? theme.get(token) ?? '' : value;
}

function rgb(hex: string): readonly [number, number, number] {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Expected a six-digit hex colour, received ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as unknown as readonly [number, number, number];
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = rgb(hex).map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('onboarding visual theme', () => {
  it('uses a Vietnamese-safe native font stack and keeps every explicit text size readable', () => {
    const light = themeBlock(/:root\s*\{([\s\S]*?)\}/);
    const fontFamily = light.get('--on-font-family') ?? stylesheet.match(/font-family:\s*([^;]+);/)?.[1] ?? '';
    const pixelSizes = [...stylesheet.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((match) => Number(match[1]));

    expect(fontFamily).toContain('"Segoe UI"');
    expect(fontFamily).toContain('"Noto Sans"');
    expect(fontFamily).not.toContain('--base-font-family');
    expect(pixelSizes.length).toBeGreaterThan(0);
    expect(pixelSizes.filter((size) => size < 12)).toEqual([]);
  });

  it.each([
    ['light', /:root\s*\{([\s\S]*?)\}/],
    ['dark', /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/],
  ])('keeps the %s palette internally consistent and readable', (_name, pattern) => {
    const theme = themeBlock(pattern);
    const background = theme.get('--on-bg') ?? '';
    const surface = theme.get('--on-surface') ?? '';
    const text = theme.get('--on-text') ?? '';
    const muted = theme.get('--on-text-soft') ?? '';

    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
    expect(surface).not.toBe(background);
    expect(contrast(text, background)).toBeGreaterThanOrEqual(7);
    expect(contrast(muted, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps native template status options readable in dark mode', () => {
    const dark = themeBlock(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
    const option = cssRule(/:root\[data-theme="dark"\]\s+\.template-filter-field option\s*\{([\s\S]*?)\}/);
    const text = resolveThemeColor(option.get('color') ?? '', dark);
    const background = resolveThemeColor(option.get('background-color') ?? '', dark);

    expect(text).toMatch(/^#[0-9a-f]{6}$/i);
    expect(background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(text, background)).toBeGreaterThanOrEqual(7);
  });

  it('keeps operation notices above modal backdrops', () => {
    const notice = cssRule(/\.inline-notice\s*\{([\s\S]*?)\}/, stylesheet);

    expect(notice.get('position')).toBe('fixed');
    expect(Number.parseInt(notice.get('z-index') ?? '0', 10)).toBeGreaterThan(50);
  });
});
