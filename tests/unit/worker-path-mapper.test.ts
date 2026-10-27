import { describe, expect, it } from 'vitest';
import {
  mapPortableRelativePathToContainer,
  mapWindowsPathToContainer,
} from '../../src/worker/worker-path-mapper.js';

describe('worker path mapping', () => {
  it('maps a registered Windows worktree below the configured root', () => {
    expect(
      mapWindowsPathToContainer(
        'C:\\Users\\luann\\Documents\\MC-Platform',
        'C:\\Users\\luann\\Documents',
        '/projects',
      ),
    ).toBe('/projects/MC-Platform');
  });

  it('rejects paths outside the configured projects root', () => {
    expect(() =>
      mapWindowsPathToContainer(
        'D:\\Private\\Project',
        'C:\\Users\\luann\\Documents',
        '/projects',
      ),
    ).toThrow('outside');
  });

  it('maps a portable vault-relative path and rejects traversal', () => {
    expect(mapPortableRelativePathToContainer('Host-Mesh', '/vaults')).toBe(
      '/vaults/Host-Mesh',
    );
    expect(() =>
      mapPortableRelativePathToContainer('../private', '/vaults'),
    ).toThrow('relative');
  });
});
