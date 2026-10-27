import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

describe('shared queue worker deployment', () => {
  it('uses one digest-pinned image with bounded Debian and Windows profiles', async () => {
    const compose = await readFile(path.join(root, 'services/queue-worker/compose.yaml'), 'utf8');
    const windows = await readFile(path.join(root, 'services/queue-worker/compose.windows.yaml'), 'utf8');
    const dockerfile = await readFile(path.join(root, 'services/queue-worker/Dockerfile'), 'utf8');
    const deploy = await readFile(path.join(root, 'scripts/deploy-queue-worker.ps1'), 'utf8');
    const build = await readFile(path.join(root, 'scripts/build-shared-worker-image.ps1'), 'utf8');
    const migrate = await readFile(path.join(root, 'scripts/migrate-project-knowledge.ps1'), 'utf8');
    expect(compose).toContain('network_mode: host');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).not.toContain('container_name:');
    expect(compose).toContain('mem_limit: 512m');
    expect(windows).toContain('source-sync,publish');
    expect(windows).toContain('read_only: true');
    expect(dockerfile).toContain('dist/shared-worker.js');
    expect(dockerfile).toContain('--max-old-space-size=384');
    expect(deploy).toContain('SupportsShouldProcess');
    expect(deploy).toContain('queue-health.js');
    expect(deploy).toContain('rollback');
    expect(deploy).toContain('ssh.exe');
    expect(build).toContain('buildx build');
    expect(build).toContain('--platform linux/amd64');
    expect(build).toContain('Get-FileHash');
    expect(migrate).toContain("ConfirmImpact = 'Medium'");
  });
});
