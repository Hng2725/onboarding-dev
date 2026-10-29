import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/ui/onboarding/styles.css', import.meta.url)),
  'utf8',
);
const shellStylesheet = readFileSync(
  fileURLToPath(new URL('../src/ui/onboarding/ai/ai-generator.css', import.meta.url)),
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
  return mediaBlock('@media (max-width: 700px)', '.ai-generator-backdrop');
}

function mediaBlock(marker: string, requiredSelector: string, source = stylesheet): string {
  let offset = 0;
  while (offset < source.length) {
    const mediaOffset = source.indexOf(marker, offset);
    if (mediaOffset < 0) break;
    const openingBrace = source.indexOf('{', mediaOffset + marker.length);
    const block = balancedBlock(source, openingBrace);
    if (block.includes(requiredSelector)) return block;
    offset = openingBrace + block.length + 2;
  }
  throw new Error(`Media block not found: ${marker} containing ${requiredSelector}`);
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
    expect(declarationValues(panel, 'display')).toEqual(['flex']);
    expect(panel).not.toContain('transform: scale');

    expect(declarationValues(rule('.ai-generator-header', shellStylesheet), 'padding')).toEqual(['16px 24px']);
    expect(declarationValues(rule('.ai-generator-body', shellStylesheet), 'padding')).toEqual(['28px 32px']);
    const footer = rule('.ai-generator-footer', shellStylesheet);
    expect(declarationValues(footer, 'padding')).toEqual(['12px 24px']);
    expect(declarationValues(footer, 'padding-right')).toEqual(['88px']);
    // The old header, step strip and kind cards no longer live in the shared stylesheet.
    for (const removed of ['.ai-generator-header', '.ai-generator-steps', '.ai-generator-body', '.ai-generator-footer', '.ai-template-kind']) {
      expect(stylesheet).not.toContain(removed);
    }

    const buttons = rule('.ai-generator-panel .button');
    expect(declarationValues(buttons, 'min-height')).toEqual(['34px']);
    expect(declarationValues(buttons, 'font-size')).toEqual(['13px']);
    expect(declarationValues(buttons, 'white-space')).toEqual(['normal']);

    const fields = rule(".ai-generator-panel input:not([type='checkbox']), .ai-generator-panel select, .ai-generator-panel textarea");
    expect(declarationValues(fields, 'font-size')).toEqual(['13px']);
    expect(declarationValues(rule('.ai-generator-panel small'), 'font-size')).toEqual(['12px']);
  });

  it('keeps long review content usable without widening the modal', () => {
    const review = rule('.ai-review-scroll');

    expect(declarationValues(rule('.ai-workspace-progress-card'), 'grid-column')).toEqual(['1 / -1']);
    expect(declarationValues(rule('.ai-generator-body', shellStylesheet), 'overflow-x')).toEqual(['hidden']);
    expect(declarationValues(review, 'max-height')).toEqual(['54dvh']);
    expect(declarationValues(review, 'overflow')).toEqual(['auto']);
  });

  it('no longer ships the multi-run roadmap and workspace styles', () => {
    for (const removed of ['.ai-roadmap-', '.ai-module-workspace', '.ai-module-stage', '.ai-outline-review', '.ai-run-sequence', '.ai-publish-target', '.ai-source-layout']) {
      expect(stylesheet).not.toContain(removed);
    }
  });

  it('preserves the full-screen single-column mobile layout', () => {
    const mobile = mobileGeneratorBlock();
    const mobileMilestones = mediaBlock('@media (max-width: 700px)', '.ai-milestone-list');
    const panel = rule('.ai-generator-panel', mobile);

    expect(declarationValues(rule('.ai-generator-backdrop', mobile), 'padding')).toEqual(['0']);
    expect(declarationValues(rule('.dialog-backdrop.ai-generator-backdrop', mobile), 'padding')).toEqual(['0']);
    expect(declarationValues(panel, 'width')).toEqual(['100%']);
    expect(declarationValues(panel, 'height')).toEqual(['100vh', '100dvh']);
    expect(declarationValues(panel, 'font-size')).toEqual(['13px']);
    expect(declarationValues(rule('.ai-milestone-list', mobileMilestones), 'grid-template-columns')).toEqual(['1fr']);
    expect(declarationValues(rule('.ai-generator-panel .button', mobile), 'min-height')).toEqual(['34px']);
  });

  it('keeps review focus intact', () => {
    expect(declarationValues(rule('.ai-review-scroll:focus-visible'), 'outline')).toEqual(['2px solid var(--on-primary)']);
  });

  it('shows the four AI milestones horizontally on desktop', () => {
    const milestones = rule('.ai-milestone-list');

    expect(declarationValues(milestones, 'grid-template-columns')).toEqual([
      'repeat(4, minmax(0, 1fr))',
    ]);
  });

  it('lays out the shell and step 1 like the approved mockup', () => {
    const stepper = rule('.ai-stepper', shellStylesheet);
    expect(declarationValues(stepper, 'display')).toEqual(['flex']);
    expect(declarationValues(stepper, 'gap')).toEqual(['10px']);
    expect(declarationValues(rule('.ai-stepper-step.done .ai-stepper-dot', shellStylesheet), 'color')).toEqual(['var(--on-success)']);
    expect(declarationValues(rule('.ai-stepper-step.active .ai-stepper-dot', shellStylesheet), 'background')).toEqual(['var(--on-primary)']);

    const kind = rule('.ai-generator-panel .ai-kind-option', shellStylesheet);
    expect(declarationValues(kind, 'border-radius')).toEqual(['var(--on-radius-md)']);
    expect(declarationValues(rule('.ai-drop', shellStylesheet), 'border-radius')).toEqual(['var(--on-radius-md)']);
    expect(declarationValues(rule('.ai-generator-panel .ai-workspace-card', shellStylesheet), 'border-radius')).toEqual(['var(--on-radius-md)']);

    const px = (value: string) => Number.parseFloat(value);
    for (const [selector, property] of [
      ['.ai-generator-panel .ai-kind-option', 'min-height'],
      ['.ai-generator-panel .button-sm', 'min-height'],
      ['.ai-generator-close', 'min-height'],
      ['.ai-generator-footer .button-primary', 'min-height'],
      ['.ai-source-file label', 'min-height'],
      ['.ai-more > summary', 'min-height'],
    ] as const) {
      expect(px(declarationValues(rule(selector, shellStylesheet), property)[0]), selector).toBeGreaterThanOrEqual(30);
    }
    for (const selector of ['.ai-kind-options', '.ai-source-files', '.ai-generator-footer-start, .ai-generator-footer-end', '.ai-step-sources']) {
      expect(px(declarationValues(rule(selector, shellStylesheet), 'gap')[0]), selector).toBeGreaterThanOrEqual(6);
    }

    const narrow = mediaBlock('@media (max-width: 900px)', '.ai-step-sources', shellStylesheet);
    expect(declarationValues(rule('.ai-step-sources', narrow), 'grid-template-columns')).toEqual(['1fr']);
    expect(declarationValues(rule('.ai-generator-footer', narrow), 'padding-right')).toEqual(['88px']);
    expect(declarationValues(rule('.ai-generator-header', narrow), 'flex-wrap')).toEqual(['wrap']);
  });
});
