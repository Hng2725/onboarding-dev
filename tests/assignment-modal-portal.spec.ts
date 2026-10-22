import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import * as employeesModule from '../src/ui/onboarding/employees';

describe('assignment modal viewport layer', () => {
  it('portals the overlay outside animated route and content stacking contexts', () => {
    const target = { nodeType: 1 } as Element;
    const layer = (employeesModule as unknown as {
      AssignmentModalLayer?: (props: { children: ReactNode; target: Element }) => unknown;
    }).AssignmentModalLayer;

    expect(layer).toBeTypeOf('function');
    const portal = layer!({ children: createElement('div'), target }) as { containerInfo?: unknown };
    expect(portal.containerInfo).toBe(target);
  });
});
