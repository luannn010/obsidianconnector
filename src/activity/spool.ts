import {
  appendFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export async function drainActivitySpool(
  spoolPath: string,
  replay: (entry: unknown) => Promise<void>,
): Promise<{ replayed: number; retained: number; invalid: number }> {
  await mkdir(path.dirname(spoolPath), { recursive: true });
  const processing = `${spoolPath}.drain-${process.pid}-${Date.now()}`;
  try {
    await rename(spoolPath, processing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(spoolPath, '', { flag: 'a', mode: 0o600 });
    return { replayed: 0, retained: 0, invalid: 0 };
  }
  await writeFile(spoolPath, '', { flag: 'a', mode: 0o600 });
  const lines = (await readFile(processing, 'utf8'))
    .split(/\r?\n/u)
    .filter(Boolean);
  const retained: string[] = [];
  let replayed = 0;
  let invalid = 0;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      invalid++;
      continue;
    }
    try {
      await replay(entry);
      replayed++;
    } catch {
      retained.push(line);
    }
  }
  if (retained.length)
    await appendFile(spoolPath, `${retained.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  await unlink(processing).catch(() => undefined);
  return { replayed, retained: retained.length, invalid };
}
