import { connect, workspace } from '@husklet/client';

declare const process: { argv: string[]; stdout: { write(value: string): void } };

const session = await connect({ path: process.argv[2], pendingLimit: 1 });
try {
  // Persist this token before the call. A retry after a lost reply returns the
  // original tab, or `closed` when the user has since closed it.
  const result = await workspace(session).terminal.openTabOnce(
    '0123456789abcdef0123456789abcdef',
    'Build output',
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await session.close();
}
