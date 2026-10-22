import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../privos-app.json';

/** Server policy and UI integrations both count as permission call sites. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('scope audit', () => {
  it('documents and exercises every declared scope', () => {
    const docs = fs.readFileSync(path.resolve('SCOPES.md'), 'utf8');
    const sources = collectSourceFiles(path.resolve('src'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    for (const permission of manifest.permissions) {
      const scope = permission.scope;
      expect(docs, `${scope} justification`).toContain(`\`${scope}\``);
      expect(sources, `${scope} call-site annotation`).toContain(scope);
      if (permission.requirement === 'optional') {
        expect(permission.degradedBehavior, `${scope} degraded behavior`).toBeTruthy();
      }
    }
  });
});
