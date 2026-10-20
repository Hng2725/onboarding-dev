import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

describe('standalone Relay Compose deployment', () => {
  it('keeps pairing state persistent and runs the production service hardened', () => {
    const result = spawnSync('docker', ['compose', '--profile', 'pair', 'config', '--format', 'json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(result.stdout);

    expect(config.services.pair).toMatchObject({
      build: { target: 'build' },
      command: ['npm', 'run', 'pair'],
      stdin_open: true,
      tty: true,
      user: 'node',
    });
    expect(config.services.app).toMatchObject({
      build: { target: 'runtime' },
      cap_drop: ['ALL'],
      read_only: true,
      restart: 'unless-stopped',
      security_opt: ['no-new-privileges:true'],
    });

    for (const serviceName of ['pair', 'app']) {
      const service = config.services[serviceName];
      expect(service.environment.PRIVOS_STANDALONE_IDENTITY_FILE).toBe(
        '/home/node/privos-standalone-identity.json',
      );
      expect(service.volumes).toContainEqual(
        expect.objectContaining({ source: 'privos-identity', target: '/home/node', type: 'volume' }),
      );
    }
  });
});
