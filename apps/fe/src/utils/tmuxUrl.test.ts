import { describe, expect, test } from 'bun:test';

import { decodePaneIdFromUrlParam, encodePaneIdForUrl } from './tmuxUrl';

describe('tmuxUrl', () => {
  test('decodePaneIdFromUrlParam preserves pane ids that legitimately start with %25', () => {
    expect(decodePaneIdFromUrlParam('%25')).toBe('%25');
    expect(decodePaneIdFromUrlParam('%251')).toBe('%251');
  });

  test('encodePaneIdForUrl keeps pane ids routable', () => {
    expect(encodePaneIdForUrl('%25')).toBe('%2525');
    expect(encodePaneIdForUrl('%251')).toBe('%25251');
  });
});
