import { describe, expect, it } from 'vitest';

import { createManifest } from '../src/manifest';

describe('installation bot room membership', () => {
  it('declares the required user-context permission to join the current room', () => {
    const permission = createManifest().permissions.find(({ scope }) => scope === 'bot:room:join');

    expect(permission).toMatchObject({
      scope: 'bot:room:join',
      requirement: 'required',
      context: 'room',
      executionContext: 'user',
    });
  });
});
