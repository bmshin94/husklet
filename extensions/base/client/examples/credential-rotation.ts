import { ExecutionStartOperationError, type WorkspaceApi } from '@husklet/client';

/**
 * Start a process with host-injected credentials. On reply loss, reconnect only to identify
 * cleanup candidates; never retry or cancel a candidate automatically because a concurrent
 * identical command remains possible.
 */
export async function startCredentialProcess(
  host: WorkspaceApi,
  reconnect: () => Promise<WorkspaceApi>,
  container: { id: string; generation: number },
  key: string,
) {
  try {
    const executionId = await host.containers.execWithCredentialsObserved(
      container.id,
      container.generation,
      {
        command: ['psql', '--no-password'],
        credentials: [['PGPASSWORD', key]],
      },
    );
    return { started: true as const, executionId };
  } catch (cause) {
    if (!(cause instanceof ExecutionStartOperationError)) throw cause;
    const resumed = await reconnect();
    const recovery = await resumed.containers.reconcileExecutionStart(cause);
    return { started: false as const, recovery };
  }
}

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
    return await host.credentials.setObserved(before.revision, key, replacement);
  } catch (cause) {
    const after = await host.credentials.read(key);
    const same =
      after.value?.length === replacement.length &&
      after.value.every((byte, index) => byte === replacement[index]);
    if (same) return after.revision;
    throw new Error(`credential ${key} rotation was not confirmed after reconnect`, { cause });
  }
}
