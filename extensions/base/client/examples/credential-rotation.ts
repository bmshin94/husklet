import type { WorkspaceApi } from '@husklet/client';

/** Rotate one named database secret with CAS, then reconcile an ambiguous disconnect by exact bytes. */
export async function rotateDatabaseCredential(
  host: WorkspaceApi,
  key: string,
  replacement: Uint8Array,
) {
  const before = await host.credentials.read(key);
  try {
    return await host.credentials.set(before.revision, key, replacement);
  } catch (cause) {
    const after = await host.credentials.read(key);
    const same =
      after.value?.length === replacement.length &&
      after.value.every((byte, index) => byte === replacement[index]);
    if (same) return after.revision;
    throw new Error(`credential ${key} rotation was not confirmed after reconnect`, { cause });
  }
}
