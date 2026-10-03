import { describe, expect, it } from 'vitest';
import { loadMetricsModule } from '../../src/metrics-loader.js';

describe('metrics module loader', () => {
  it('returns null when the metrics package cannot be loaded', () => {
    expect(
      loadMetricsModule(() => {
        throw new Error('Cannot find module');
      }),
    ).toBeNull();
  });
});
