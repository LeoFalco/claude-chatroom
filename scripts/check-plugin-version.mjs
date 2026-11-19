// Fails when files the plugin ships changed since <base> but .claude-plugin/plugin.json kept its
// version: Claude Code only updates installed plugins when that version changes.
// Usage: node scripts/check-plugin-version.mjs <base-commit>
import { execFileSync } from 'node:child_process';

const SHIPPED = /^(src|bin|skills|\.claude-plugin)\/|^package(-lock)?\.json$/;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const base = process.argv[2];
if (!base || /^0+$/.test(base)) {
  console.log('No base commit to compare with; skipping.');
  process.exit(0);
}

const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter((f) => SHIPPED.test(f));
if (changed.length === 0) {
  console.log('No plugin files changed.');
  process.exit(0);
}

const version = (rev) => JSON.parse(git('show', `${rev}:.claude-plugin/plugin.json`)).version;
let before;
try {
  before = version(base);
} catch {
  console.log('The base commit has no plugin manifest; skipping.');
  process.exit(0);
}
const after = version('HEAD');
if (before === after) {
  console.error(
    `Plugin files changed but .claude-plugin/plugin.json is still at version ${after}, so installed plugins will not update.\n` +
      `Bump the version (plugin.json, package.json, package-lock.json and VERSION in src/mcp.js). Changed:\n  ${changed.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`Plugin version ${before} -> ${after}.`);
