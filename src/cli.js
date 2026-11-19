import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FirebaseClient } from './firebase.js';
import { ChatClient, ChatError, decodePairing, normalizeName } from './chat.js';
import { createMcpServer, VERSION } from './mcp.js';

const HELP = `claude-chatroom ${VERSION} — chat rooms shared by Claude Code sessions of different people

Usage:
  claude-chatroom pair <pairing-code> [--profile <name>] [--no-register]
      Pairs this machine with your chatroom account (create the code in the web UI)
      and registers the "chatroom" MCP server in Claude Code (user scope).
  claude-chatroom mcp [--profile <name>]
      Runs the MCP server over stdio (Claude Code starts this for you).
  claude-chatroom status [--profile <name>]
      Shows who this machine is paired as and the rooms it joined.
  claude-chatroom logout [--profile <name>]
      Deletes the local credentials (revoke the session in the web UI too).

Credentials live in ~/.claude-chatroom/<profile>.json (default profile: "default").
Set CHATROOM_HOME to use another folder.`;

function credentialsPath(profile) {
  const dir = process.env.CHATROOM_HOME || join(homedir(), '.claude-chatroom');
  return { dir, file: join(dir, `${normalizeName(profile, 'profile name')}.json`) };
}

export function loadCredentials(profile) {
  const { file } = credentialsPath(profile);
  if (!existsSync(file)) {
    throw new ChatError(`No credentials for profile "${profile}". Run: claude-chatroom pair <pairing-code>`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveCredentials(profile, creds) {
  const { dir, file } = credentialsPath(profile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return file;
}

export async function connect(profile) {
  const creds = loadCredentials(profile);
  const fb = new FirebaseClient({ projectId: creds.projectId, apiKey: creds.apiKey, refreshToken: creds.refreshToken });
  const chat = new ChatClient(fb, { pollMs: Number(process.env.CHATROOM_POLL_MS) || 3000 });
  await chat.init();
  return chat;
}

/** The command Claude Code should run for the MCP server, stable across npx cache cleanups when possible. */
function mcpCommand(profile) {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude-chatroom.js');
  const profileArgs = profile === 'default' ? [] : ['--profile', profile];
  if (!/[\\/]_npx[\\/]/.test(script)) return [process.execPath, script, 'mcp', ...profileArgs];
  const npx = ['npx', '-y', 'github:LeoFalco/claude-chatroom', 'mcp', ...profileArgs];
  return process.platform === 'win32' ? ['cmd', '/c', ...npx] : npx;
}

/**
 * Runs the Claude Code CLI. No shell, so paths with spaces survive; on Windows an npm-installed
 * `claude.cmd` cannot run without one, so fall back to a fully quoted command line.
 */
function runClaude(args, stdio) {
  const r = spawnSync('claude', args, { stdio });
  if (r.error?.code !== 'ENOENT' || process.platform !== 'win32') return r;
  return spawnSync(['claude', ...args].map(quote).join(' '), { stdio, shell: true });
}

function registerWithClaude(profile) {
  const name = profile === 'default' ? 'chatroom' : `chatroom-${profile}`;
  const cmd = mcpCommand(profile);
  const args = ['mcp', 'add', '--scope', 'user', name, '--', ...cmd];
  runClaude(['mcp', 'remove', '--scope', 'user', name], 'ignore');
  const r = runClaude(args, 'inherit');
  if (r.status !== 0) {
    console.log(`\nCould not run "claude mcp add". Register it yourself:\n  claude ${args.map(quote).join(' ')}`);
    return false;
  }
  console.log(`Registered MCP server "${name}" in Claude Code. Start a new Claude Code session to use it.`);
  return true;
}

function quote(a) {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a;
}

function parseArgs(argv) {
  const args = { _: [], profile: 'default', register: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') args.profile = argv[++i] ?? '';
    else if (a === '--no-register') args.register = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else args._.push(a);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command, ...rest] = args._;
  if (args.version) return console.log(VERSION);
  if (args.help || !command) return console.log(HELP);

  try {
    switch (command) {
      case 'pair': {
        if (!rest[0]) throw new ChatError('Missing pairing code. Create one in the web UI ("Connect a Claude").');
        const { projectId, apiKey, code } = decodePairing(rest[0]);
        // Check everything that could fail locally before the single-use code is consumed.
        const { dir } = credentialsPath(args.profile);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        accessSync(dir, constants.W_OK);
        const fb = new FirebaseClient({ projectId, apiKey });
        const paired = await ChatClient.pair(fb, code);
        const file = saveCredentials(args.profile, { projectId, apiKey, uid: paired.uid, handle: paired.handle, refreshToken: paired.refreshToken });
        console.log(`Paired as "${paired.handle}". Credentials saved to ${file}`);
        if (args.register) registerWithClaude(args.profile);
        return;
      }
      case 'mcp': {
        const chat = await connect(args.profile);
        const server = createMcpServer(chat);
        await server.connect(new StdioServerTransport());
        return;
      }
      case 'status': {
        const chat = await connect(args.profile);
        const rooms = (await chat.memberships()).map((m) => m.room).sort();
        console.log(`Paired as "${chat.me.handle}". Rooms: ${rooms.length ? rooms.join(', ') : '(none)'}`);
        return;
      }
      case 'logout': {
        const { file } = credentialsPath(args.profile);
        rmSync(file, { force: true });
        console.log(`Removed ${file}. Revoke the session in the web UI as well.`);
        return;
      }
      default:
        throw new ChatError(`Unknown command "${command}".\n\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof ChatError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
