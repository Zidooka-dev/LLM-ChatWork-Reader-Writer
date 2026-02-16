#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';
import { ChatworkClient } from './chatwork-client.mjs';

const HELP_TEXT = `LLM-ChatWork-Reader/Writer

Usage:
  llm-chatwork-rw <command> [options]
  node src/cli.mjs <command> [options]

Commands:
  me                                      Show current account.
  rooms                                   List accessible rooms.
  read   --room <roomId>                  Read messages from a room.
  write  --room <roomId> [--message "..."] Post a message to a room.

Global Options:
  --token <token>                         ChatWork API token.
  --env-file <path>                       Load token from .env-style file.
  --json                                  JSON output.
  --help                                  Show this help.

Read Options:
  --limit <n>                             Number of messages (1-100, default: 30).
  --since <unix|YYYY-MM-DD|ISO8601>       Lower send_time bound.
  --until <unix|YYYY-MM-DD|ISO8601>       Upper send_time bound.
  --contains <text>                       Filter body by substring.
  --force <0|1>                           Pass force param to ChatWork API (default: 1).
  --strip-tags                            Remove common ChatWork tags.
  --jsonl                                 Print one JSON object per line.

Write Options:
  --message "<text>"                      Message body.
  --file <path>                           Read message body from file.
  --to <accountId[,accountId...]>         Prepend ChatWork [To:] tags.
  --reply-account <accountId>             Reply source account id for [rp].
  --reply-message <messageId>             Reply source message id for [rp].
  --dry-run                               Build body but do not send.

Token Resolution Order:
  1) --token
  2) CHATWORK_API_TOKEN
  3) CHATWORK_TOKEN
  4) --env-file (CHATWORK_API_TOKEN / CHATWORK_TOKEN)
`;

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=');
      options[key] = rest.join('=');
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[body] = next;
      i += 1;
    } else {
      options[body] = true;
    }
  }
  return { options, positionals };
}

function parseIntSafe(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseUnixTime(input, optionName) {
  if (input === undefined || input === null || input === '') return undefined;
  if (/^\d+$/.test(String(input))) return Number(input);
  const ms = Date.parse(String(input));
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${optionName}: ${input}`);
  }
  return Math.floor(ms / 1000);
}

function parseBool01(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true) return 1;
  const normalized = String(value).toLowerCase();
  if (normalized === '1' || normalized === 'true') return 1;
  if (normalized === '0' || normalized === 'false') return 0;
  return fallback;
}

async function maybeLoadEnvFile(filePath) {
  if (!filePath) return {};
  const text = await fs.readFile(filePath, 'utf8');
  const envMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    envMap[key] = value;
  }
  return envMap;
}

function resolveToken(options, envFromFile) {
  return (
    options.token ||
    process.env.CHATWORK_API_TOKEN ||
    process.env.CHATWORK_TOKEN ||
    envFromFile.CHATWORK_API_TOKEN ||
    envFromFile.CHATWORK_TOKEN
  );
}

function stripCommonChatworkTags(body) {
  return String(body || '')
    .replace(/\[To:\d+\]/g, '')
    .replace(/\[rp aid=\d+ to=\d+-\d+\]/g, '')
    .replace(/\[info\]|\[\/info\]|\[title\]|\[\/title\]|\[code\]|\[\/code\]|\[qt\]|\[\/qt\]/g, '')
    .trim();
}

function normalizeReadMessage(roomId, rawMessage, stripTags) {
  const rawBody = String(rawMessage.body || '');
  const body = stripTags ? stripCommonChatworkTags(rawBody) : rawBody;
  const sendTimeUnix = Number(rawMessage.send_time || 0);
  return {
    roomId: String(roomId),
    messageId: String(rawMessage.message_id || ''),
    sendTimeUnix,
    sendTimeIso: sendTimeUnix ? new Date(sendTimeUnix * 1000).toISOString() : null,
    accountId: rawMessage.account?.account_id ?? null,
    accountName: rawMessage.account?.name ?? null,
    body,
    rawBody,
  };
}

function printRoomsText(rooms) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    console.log('No rooms found.');
    return;
  }
  console.log('room_id\tname\ttype\trole\tunread\tmention');
  for (const room of rooms) {
    console.log(
      [
        room.room_id,
        room.name,
        room.type,
        room.role,
        room.unread_num ?? 0,
        room.mention_num ?? 0,
      ].join('\t')
    );
  }
}

function printMessagesText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    console.log('No messages matched.');
    return;
  }
  for (const msg of messages) {
    console.log(
      `[#${msg.messageId}] ${msg.sendTimeIso || '-'} ${msg.accountName || 'Unknown'} (${msg.accountId ?? '-'})`
    );
    console.log(msg.body);
    console.log('');
  }
}

async function readStdinMessage() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function resolveWriteMessage(options) {
  if (options.message) return String(options.message);
  if (options.file) {
    const fromFile = await fs.readFile(String(options.file), 'utf8');
    return fromFile.trim();
  }
  return readStdinMessage();
}

function buildChatworkBody(roomId, messageBody, options) {
  const lines = [];

  if (options.to) {
    const ids = String(options.to)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (const id of ids) {
      lines.push(`[To:${id}]`);
    }
  }

  const replyAccount = options['reply-account'];
  const replyMessage = options['reply-message'];
  if ((replyAccount && !replyMessage) || (!replyAccount && replyMessage)) {
    throw new Error('Use --reply-account and --reply-message together.');
  }
  if (replyAccount && replyMessage) {
    lines.push(`[rp aid=${replyAccount} to=${roomId}-${replyMessage}]`);
  }

  lines.push(messageBody);
  return lines.join('\n');
}

async function runMe(client, options) {
  const me = await client.getMe();
  if (options.json) {
    console.log(JSON.stringify(me, null, 2));
    return;
  }
  console.log(`${me.account_id}\t${me.name}`);
}

async function runRooms(client, options) {
  let rooms = await client.getRooms();
  if (options.contains) {
    const needle = String(options.contains).toLowerCase();
    rooms = (rooms || []).filter((room) => String(room.name || '').toLowerCase().includes(needle));
  }
  if (options.json) {
    console.log(JSON.stringify(rooms, null, 2));
    return;
  }
  printRoomsText(rooms);
}

async function runRead(client, options) {
  const roomId = options.room;
  if (!roomId) throw new Error('read requires --room <roomId>.');

  const limit = Math.max(1, Math.min(100, parseIntSafe(options.limit, 30)));
  const since = parseUnixTime(options.since, '--since');
  const until = parseUnixTime(options.until, '--until');
  const contains = options.contains ? String(options.contains) : '';
  const force = parseBool01(options.force, 1);
  const stripTags = Boolean(options['strip-tags']);

  const raw = await client.getRoomMessages(roomId, { force });
  const filtered = (Array.isArray(raw) ? raw : [])
    .filter((msg) => (since !== undefined ? Number(msg.send_time) >= since : true))
    .filter((msg) => (until !== undefined ? Number(msg.send_time) <= until : true))
    .filter((msg) => (contains ? String(msg.body || '').includes(contains) : true))
    .sort((a, b) => Number(a.send_time) - Number(b.send_time))
    .slice(-limit)
    .map((msg) => normalizeReadMessage(roomId, msg, stripTags));

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (options.jsonl) {
    for (const row of filtered) {
      console.log(JSON.stringify(row));
    }
    return;
  }
  printMessagesText(filtered);
}

async function runWrite(client, options) {
  const roomId = options.room;
  if (!roomId) throw new Error('write requires --room <roomId>.');

  const messageBody = await resolveWriteMessage(options);
  if (!messageBody) {
    throw new Error('write requires message text via --message, --file, or stdin.');
  }

  const body = buildChatworkBody(roomId, messageBody, options);

  if (options['dry-run']) {
    const preview = { roomId: String(roomId), body };
    console.log(options.json ? JSON.stringify(preview, null, 2) : body);
    return;
  }

  const result = await client.postRoomMessage(roomId, { body });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Sent room_id=${roomId} message_id=${result.message_id}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    return;
  }

  const command = argv[0];
  const { options } = parseArgs(argv.slice(1));

  if (command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const envFromFile = await maybeLoadEnvFile(options['env-file']).catch((err) => {
    throw new Error(`Failed to read --env-file: ${err.message}`);
  });

  const token = resolveToken(options, envFromFile);
  const allowNoToken = command === 'write' && Boolean(options['dry-run']);
  if (!token && !allowNoToken) {
    throw new Error('Missing API token. Set CHATWORK_API_TOKEN or use --token.');
  }

  const client = token ? new ChatworkClient({ token }) : null;

  if (command === 'me') {
    await runMe(client, options);
    return;
  }
  if (command === 'rooms') {
    await runRooms(client, options);
    return;
  }
  if (command === 'read') {
    await runRead(client, options);
    return;
  }
  if (command === 'write') {
    await runWrite(client, options);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`[llm-chatwork-rw] ${err.message}`);
  process.exitCode = 1;
});
