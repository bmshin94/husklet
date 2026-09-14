import {
  ExecutionOperationError,
  FileWriteOperationError,
  FileWriteProtocolError,
  type WorkspaceApi,
} from '@husklet/client';

/** Resume an interrupted bounded Git status/diff without losing bytes acknowledged before reconnect. */
export async function resumeGitText(
  host: WorkspaceApi,
  failure: ExecutionOperationError,
  maxBytes = 1024 * 1024,
) {
  if (!failure.containerId) {
    throw new Error('Git execution recovery is missing its original container identity');
  }
  const stdout = [...(failure.stdout ?? [])];
  const stderr = [...(failure.stderr ?? [])];
  if (stdout.length + stderr.length > maxBytes)
    throw new RangeError('saved Git output is too large');
  const resumed = await host.containers.resumeExecutionFailureStreaming(
    failure,
    {
      pageLimit: 2,
      maxPages: 4_096,
    },
    (page) => {
      const additions = { stdout: [] as number[], stderr: [] as number[] };
      for (const entry of page.entries) additions[entry.stream].push(...entry.bytes);
      if (
        stdout.length + stderr.length + additions.stdout.length + additions.stderr.length >
        maxBytes
      ) {
        throw new RangeError('resumed Git output is too large');
      }
      stdout.push(...additions.stdout);
      stderr.push(...additions.stderr);
    },
  );
  const decode = (bytes: number[]) =>
    new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  return { ...resumed, stdout: decode(stdout), stderr: decode(stderr) };
}

/** Reconcile a reviewed file whose atomic write committed before its reply was lost. */
export async function resumeReviewedFileWrite(host: WorkspaceApi, failure: unknown) {
  // A mismatched receipt is a protocol violation, never an ambiguous write to reconcile.
  if (failure instanceof FileWriteProtocolError) throw failure;
  if (!(failure instanceof FileWriteOperationError)) throw failure;
  return host.files.recoverObservedWrite(failure);
}

/** Apply one reviewed file edit against its exact read identity, then run a bounded check. */
export async function applyReviewedFile(
  host: WorkspaceApi,
  target: { path: string; container: string; generation: number; replacement: string },
) {
  if (host.files.pathGrant('read', target.path) === null)
    throw new Error(
      `review target ${JSON.stringify(target.path)} is outside filesystem:read consent`,
    );
  if (host.files.pathGrant('write', target.path) === null)
    throw new Error(
      `review target ${JSON.stringify(target.path)} is outside filesystem:write consent`,
    );
  const file = await host.files.readText(target.path, {
    maxBytes: 1024 * 1024,
    chunkBytes: 64 * 1024,
  });
  const written = await host.files.writeTextObserved(file, target.replacement);
  const check = await host.containers.execText(target.container, target.generation, {
    command: ['git', 'diff', '--check', '--', target.path],
    maxBytes: 256 * 1024,
    pageLimit: 2,
  });
  return { written, check };
}
