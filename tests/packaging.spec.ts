import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import pkg from '../package.json';

// Derive the complete archive name from package metadata so renames and releases cannot
// leave this safety check pointing at a stale file.
const safeName = pkg.name.replaceAll('/', '-');
const archive = `dist-source/${safeName}-${pkg.version}.zip`;

const planted = '.env.bak.preflight-test';
afterEach(() => { if (fs.existsSync(planted)) fs.unlinkSync(planted); });

describe('safe packaging', () => {
  it('keeps every .env path out of the Marketplace ZIP', () => {
    const result = spawnSync('bash', ['scripts/package-source.sh', '--allow-dirty'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout.split('\n').filter((entry) => /(^|\/)\.env(?:\.|$)/.test(entry))).toEqual([]);
  });

  it('rejects a planted credential-like file', () => {
    fs.writeFileSync(planted, 'TOKEN=not-a-real-secret\n');
    const result = spawnSync('bash', ['scripts/package-source.sh', '--allow-dirty'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsafe credential-like files');
  });
});
