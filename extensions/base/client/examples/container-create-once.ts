import { connect, workspace, type ContainerCreateSpec } from '@husklet/client';

declare const process: { argv: string[]; stdout: { write(value: string): void } };

type Configuration = { path: string; token: string; spec: ContainerCreateSpec };
const configuration = JSON.parse(process.argv[2] ?? 'null') as Configuration | null;
if (!configuration?.path || !configuration.token || !configuration.spec)
  throw new TypeError('usage: container-create-once.ts JSON(path, token, spec)');

// Persist `token` before this call. If the socket closes after creation but before
// its reply, reconnect—even after a workspace-host restart—and repeat this exact call:
// the host returns only the original immutable ID and rejects a token paired
// with a different spec. Persisted tombstones also survive container removal and name reuse.
const session = await connect({ path: configuration.path, pendingLimit: 1, timeout: 5_000 });
try {
  const id = await workspace(session).containers.createOnce(
    configuration.token,
    configuration.spec,
  );
  process.stdout.write(`${JSON.stringify({ id })}\n`);
} finally {
  await session.close();
}
