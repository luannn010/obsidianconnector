import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

describe('Debian queue worker deployment', () => {
  it('uses host networking, a content-addressed release, health verification, and rollback', async () => {
    const compose = await readFile(path.join(root, 'services/queue-worker/compose.yaml'), 'utf8');
    const dockerfile = await readFile(path.join(root, 'services/queue-worker/Dockerfile'), 'utf8');
    const deploy = await readFile(path.join(root, 'scripts/deploy-queue-worker.ps1'), 'utf8');
    expect(compose).toContain('network_mode: host');
    expect(compose).toContain('restart: unless-stopped');
    expect(dockerfile).toContain('dist/queue-worker.js');
    expect(deploy).toContain('SupportsShouldProcess');
    expect(deploy).toContain('Get-FileHash');
    expect(deploy).toContain('queue-health.js');
    expect(deploy).toContain('rollback');
    expect(deploy).toContain('ssh.exe');
  });
});
