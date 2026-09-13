import { connect, workspace } from '@husklet/client';

declare const process: { argv: string[]; stdout: { write(value: string): void } };

const [path, slot] = process.argv.slice(2);
if (!path || !slot) throw new TypeError('usage: terminal-history.ts SOCKET SLOT');

const session = await connect({ path });
try {
  const terminal = workspace(session).terminal;
  const observed = await terminal.read(slot, 40);
  for await (const page of terminal.historyPages(observed, {
    lines: 200,
    maxPages: 8,
    maxBytes: 4 * 1024 * 1024,
  })) {
    for (const line of page.lines) process.stdout.write(`${line}\n`);
  }
} finally {
  await session.close();
}
