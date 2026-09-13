import type { WorkspaceApi } from '@husklet/client';

/**
 * Give a database client a short-lived view of the current secret. Disconnect, installation
 * replacement, caller cancellation, or lease expiry aborts the operation and scrubs that view.
 */
export async function withDatabaseCredential(
  host: WorkspaceApi,
  key: string,
  connect: (password: Uint8Array, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
) {
  if (!host.credentials.keyGrant('read', key)) {
    throw new Error(`credential ${key} is outside this extension's exact read grant`);
  }
  return host.credentials.withValue(key, (password, lease) => connect(password, lease.signal), {
    signal,
    maxLifetimeMs: 30_000,
  });
}

/** Rotate one named database secret with CAS, then reconcile an ambiguous disconnect by exact bytes. */
export async function rotateDatabaseCredential(
  host: WorkspaceApi,
  key: string,
  replacement: Uint8Array,
) {
  if (!host.credentials.keyGrant('read', key) || !host.credentials.keyGrant('write', key)) {
    throw new Error(`credential ${key} is outside this extension's exact read/write grant`);
  }
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
