import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [, , operation, rawInput] = process.argv;
if (!operation || (operation !== 'list' && !rawInput)) {
  console.error(
    'usage: node scripts/invoke-obsidian-mcp.mjs <tool> <json-input>',
  );
  process.exit(2);
}

const client = new Client({
  name: 'obsidian-on-demand-pipeline',
  version: '1.0.0',
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: process.env,
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  if (operation === 'list') {
    const result = await client.listTools();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const result = await client.callTool({
      name: operation,
      arguments: JSON.parse(rawInput),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await transport.close();
}
