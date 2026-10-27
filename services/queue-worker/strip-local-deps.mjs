// Removes host-only `file:` dependencies (for example the optional MCP metrics
// package that lives on the Windows workstation) from package.json and
// package-lock.json so `npm ci` works inside the worker image. The runtime
// loads that package optionally, so the worker does not need it.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const removed = [];

for (const section of ['dependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    delete manifest[section][name];
    delete lock.packages?.['']?.[section]?.[name];
    const linked = lock.packages?.[`node_modules/${name}`];
    if (linked?.link) delete lock.packages[linked.resolved];
    delete lock.packages?.[`node_modules/${name}`];
    removed.push(name);
  }
}

writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
console.log(JSON.stringify({ removedLocalDependencies: removed }));
