import { FileChunkLimitError, FileChunkOperationError, connect, workspace } from '@husklet/client';

declare const process: { argv: string[] };

const [path, file, identity] = process.argv.slice(2);
if (!path || !file) throw new TypeError('usage: bounded-file-chunks.ts SOCKET FILE [IDENTITY]');

const session = await connect({ path });
try {
  const chunks = workspace(session).files.readChunks(file, {
    observed: identity ?? null,
    chunkBytes: 64 * 1024,
    maxBytes: 64 * 1024 * 1024,
    maxChunks: 1_024,
  });
  try {
    for await (const chunk of chunks) void chunk.contents;
  } catch (cause) {
    if (cause instanceof FileChunkLimitError) {
      // Persist these values and resume only this immutable file identity.
      console.log({ identity: cause.identity, offset: cause.offset, total: cause.total });
    } else if (cause instanceof FileChunkOperationError) {
      // Reconnect first, then pass the typed failure to `resumeChunks`; it pins the
      // continuation to this identity and rejects a replacement file.
      console.log({ reconnect: true, identity: cause.identity, offset: cause.offset });
    } else {
      throw cause;
    }
  }
} finally {
  await session.close();
}
