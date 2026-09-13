import { connect, workspace } from '@husklet/client';
import type { TerminalHistoryCursor } from '@husklet/client';

declare const process: { argv: string[]; stdout: { write(value: string): void } };

const [path, slot] = process.argv.slice(2);
if (!path || !slot) throw new TypeError('usage: terminal-history.ts SOCKET SLOT');

const session = await connect({ path });
try {
  const terminal = workspace(session).terminal;
  const observed = await terminal.read(slot, 40);
  let cursor: TerminalHistoryCursor | undefined;
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page = await terminal.readHistory(observed, { cursor, lines: 200 });
    for (const line of page.lines) process.stdout.write(`${line}\n`);
    cursor = page.next ?? undefined;
    if (!cursor) break;
  }
  if (cursor)
    process.stdout.write('[older history remains; resume with the same pane observation]\n');
} finally {
  await session.close();
}
