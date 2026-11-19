#!/usr/bin/env node
// MCP entry point of the Claude Code plugin. The plugin cache holds the sources only, so the
// runtime dependencies are installed next to them on the first start. Nothing but the MCP
// protocol may reach stdout, so npm writes to stderr.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

if (!existsSync(fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url)))) {
  const r = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: ['ignore', 2, 2],
    shell: process.platform === 'win32', // npm is npm.cmd there
  });
  if (r.status !== 0) {
    console.error(`claude-chatroom: could not install dependencies in ${root} (npm ci exited with ${r.status ?? r.error?.message}).`);
    process.exit(1);
  }
}

const { main } = await import('../src/cli.js');
main(['mcp', ...process.argv.slice(2)]).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
