import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('retrieval model deployment', () => {
  it('binds for container traffic and applies restart and memory limits', async () => {
    const [dockerfile, compose] = await Promise.all([
      readFile('services/retrieval-model/Dockerfile', 'utf8'),
      readFile('services/retrieval-model/compose.yaml', 'utf8'),
    ]);

    expect(dockerfile).toContain('"--host","0.0.0.0"');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('mem_limit: ${RETRIEVAL_MODEL_MEMORY_LIMIT:-4g}');
  });
});
