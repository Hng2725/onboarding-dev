import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/ui/onboarding/styles.css', import.meta.url)),
  'utf8',
);

function balancedBlock(source: string, openingBrace: number): string {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Unclosed CSS block at offset ${openingBrace}`);
}

function rule(selector: string, source = stylesheet): string {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (depth === 0 && source.startsWith(selector, index)) {
      const openingBrace = source.indexOf('{', index + selector.length);
      if (openingBrace < 0) throw new Error(`CSS rule has no body: ${selector}`);
      return balancedBlock(source, openingBrace);
    }
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
  }
  throw new Error(`CSS selector not found at the current level: ${selector}`);
}

function declarationValues(block: string, property: string): readonly string[] {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...block.matchAll(new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`, 'g'))]
    .map((match) => match[1].trim());
}

function mobileGeneratorBlock(): string {
  const marker = '@media (max-width: 700px)';
  let offset = 0;
  while (offset < stylesheet.length) {
    const mediaOffset = stylesheet.indexOf(marker, offset);
    if (mediaOffset < 0) break;
    const openingBrace = stylesheet.indexOf('{', mediaOffset + marker.length);
    const block = balancedBlock(stylesheet, openingBrace);
    if (block.includes('.ai-generator-backdrop')) return block;
    offset = openingBrace + block.length + 2;
  }
  throw new Error('AI Generator mobile media block not found');
}

describe('AI Generator compact modal density', () => {
  it('uses a near-viewport compact desktop modal', () => {
    const backdrop = rule('.ai-generator-backdrop');
    const panel = rule('.ai-generator-panel');

    expect(declarationValues(backdrop, 'padding')).toEqual(['8px']);
    expect(declarationValues(panel, 'width')).toEqual(['min(1920px, calc(100vw - 16px))']);
    expect(declarationValues(panel, 'height')).toEqual([
      'calc(100vh - 16px)',
      'calc(100dvh - 16px)',
    ]);
    expect(declarationValues(panel, 'font-size')).toEqual(['13px']);
    expect(panel).not.toContain('transform: scale');

    expect(declarationValues(rule('.ai-generator-header'), 'padding')).toEqual(['12px 16px']);
    expect(declarationValues(rule('.ai-generator-steps'), 'padding')).toEqual(['8px 16px']);
    expect(declarationValues(rule('.ai-generator-body'), 'padding')).toEqual(['12px 14px']);
    expect(declarationValues(rule('.ai-generator-footer'), 'padding')).toEqual(['8px 14px']);

    const buttons = rule('.ai-generator-panel .button');
    expect(declarationValues(buttons, 'min-height')).toEqual(['34px']);
    expect(declarationValues(buttons, 'font-size')).toEqual(['13px']);
    expect(declarationValues(buttons, 'white-space')).toEqual(['normal']);

    const fields = rule(".ai-generator-panel input:not([type='checkbox']), .ai-generator-panel select, .ai-generator-panel textarea");
    expect(declarationValues(fields, 'font-size')).toEqual(['13px']);
  });

  it('keeps long review content usable without widening the modal', () => {
    const workspace = rule('.ai-module-workspace');
    const review = rule('.ai-review-scroll');

    expect(declarationValues(workspace, 'grid-template-columns')).toEqual(['200px minmax(0, 1fr)']);
    expect(declarationValues(workspace, 'gap')).toEqual(['12px']);
    expect(declarationValues(workspace, 'min-width')).toEqual(['0']);
    expect(declarationValues(rule('.ai-generator-body'), 'overflow-x')).toEqual(['hidden']);
    expect(declarationValues(review, 'max-height')).toEqual(['54dvh']);
    expect(declarationValues(review, 'overflow')).toEqual(['auto']);
    expect(declarationValues(rule('.ai-outline-review > .ai-review-scroll'), 'max-height')).toEqual(['56dvh']);
    expect(declarationValues(rule('.ai-module-actions'), 'flex-wrap')).toEqual(['wrap']);
  });

  it('preserves the full-screen single-column mobile layout', () => {
    const mobile = mobileGeneratorBlock();
    const panel = rule('.ai-generator-panel', mobile);

    expect(declarationValues(rule('.ai-generator-backdrop', mobile), 'padding')).toEqual(['0']);
    expect(declarationValues(rule('.dialog-backdrop.ai-generator-backdrop', mobile), 'padding')).toEqual(['0']);
    expect(declarationValues(panel, 'width')).toEqual(['100%']);
    expect(declarationValues(panel, 'height')).toEqual(['100vh', '100dvh']);
    expect(declarationValues(panel, 'font-size')).toEqual(['13px']);
    expect(declarationValues(rule('.ai-module-workspace', mobile), 'grid-template-columns')).toEqual(['1fr']);
    expect(declarationValues(rule('.ai-generator-panel .button', mobile), 'min-height')).toEqual(['34px']);
  });

  it('keeps review focus and sticky actions intact', () => {
    const focusRule = rule('.ai-review-scroll:focus-visible, .ai-module-stage summary:focus-visible');
    const toolbar = rule('.ai-review-toolbar');

    expect(declarationValues(focusRule, 'outline')).toEqual(['2px solid var(--on-primary)']);
    expect(declarationValues(toolbar, 'position')).toEqual(['sticky']);
  });
});
