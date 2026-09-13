import {
  ExecutionOperationError,
  TemporaryNetworkConnectionAcquisitionError,
  TemporaryNetworkConnectionError,
  connect,
  workspace,
} from '@husklet/client';

declare const process: { argv: string[]; stdout: { write(value: string): void } };

type Configuration = {
  path: string;
  containerId: string;
  generation: number;
  networkId: string;
  database: string;
  query: string;
  passwordCredential: string;
  timeoutMs?: number;
};

const configuration = JSON.parse(process.argv[2] ?? 'null') as Configuration | null;
if (
  !configuration?.path ||
  !configuration.containerId ||
  !Number.isSafeInteger(configuration.generation) ||
  !configuration.networkId ||
  !configuration.database ||
  !configuration.query ||
  !configuration.passwordCredential
) {
  throw new TypeError(
    'usage: postgres-browser.ts JSON(path, containerId, generation, networkId, database, query, passwordCredential, timeoutMs?)',
  );
}

const session = await connect({ path: configuration.path, pendingLimit: 8, timeout: 5_000 });
let executionId: string | undefined;
try {
  const containers = workspace(session).containers;
  // A saved database target is an exact lifecycle identity. Never follow a reused
  // container ID/name onto a replacement generation without fresh user selection.
  const container = await containers.inspectObserved(
    configuration.containerId,
    configuration.generation,
  );
  if (container.state !== 'running') throw new Error('Postgres container is not running');

  const query = configuration.query.trim().replace(/;$/, '');
  if (!query) throw new TypeError('query must contain a row-producing statement');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort('query timed out'), configuration.timeoutMs ?? 30_000);
  let rows = 0;
  const preview: unknown[] = [];
  const notices: string[] = [];
  try {
    const result = await workspace(session).networks.withTemporaryConnection(
      configuration.networkId,
      container.id,
      () =>
        containers.execJsonLines(
          container.id,
          container.generation,
          {
            command: [
              'psql',
              '--no-psqlrc',
              '--quiet',
              '--tuples-only',
              '--no-align',
              '--dbname',
              configuration.database,
              '--file',
              '-',
            ],
            credentials: [['PGPASSWORD', configuration.passwordCredential]],
            input: [`SELECT row_to_json(husklet_row)::text FROM (${query}) AS husklet_row;\n`],
            maxLineBytes: 1024 * 1024,
            pageLimit: 16,
            signal: abort.signal,
            onStarted: (id) => {
              executionId = id;
            },
            onStderr: (text) => {
              if (notices.length < 25) notices.push(text.slice(0, 4_096));
            },
          },
          (value) => {
            rows += 1;
            if (preview.length < 25) preview.push(value);
          },
        ),
      { aliases: ['postgres-inspector'] },
    );
    const execution = result.execution;
    if (execution.exit_code !== 0) {
      const output = await containers.executionLogs(result.executionId, {
        stdout: false,
        stderr: true,
      });
      throw new Error(
        `psql exited with status ${execution.exit_code ?? 'unknown'}: ${new TextDecoder().decode(Uint8Array.from(output.stderr))}`,
      );
    }
    process.stdout.write(`${JSON.stringify({ rows, preview, notices })}\n`);
  } catch (error) {
    if (error instanceof TemporaryNetworkConnectionAcquisitionError) {
      // The host may have attached before its reply was lost. Reconnect, inspect complete
      // membership, and release the exact ambiguous endpoint without ever reading the password.
      const resumedSession = await connect({
        path: configuration.path,
        pendingLimit: 8,
        timeout: 5_000,
      });
      try {
        const resumedNetworks = workspace(resumedSession).networks;
        const network = await resumedNetworks.inspect(error.networkId);
        if (network.endpoints === undefined || network.endpoints.truncated) throw error;
        if (network.endpoints.containers.includes(error.containerId)) {
          await resumedNetworks.disconnect(error.networkId, error.containerId);
        }
      } finally {
        await resumedSession.close();
      }
      throw error;
    }
    let recovered = false;
    const leaseFailure = error instanceof TemporaryNetworkConnectionError ? error : undefined;
    const operationFailure = leaseFailure?.operation ?? error;
    if (operationFailure instanceof ExecutionOperationError) {
      executionId = operationFailure.executionId;
      if (operationFailure.after !== undefined && operationFailure.partialLine !== undefined) {
        // A transport failure leaves the execution record on the host. Reconnect and commit each
        // decoded result page as one unit before advancing its authoritative output cursor.
        const resumedSession = await connect({
          path: configuration.path,
          pendingLimit: 8,
          timeout: 5_000,
        });
        try {
          const resumed = await workspace(resumedSession).containers.resumeJsonLinePages(
            operationFailure.executionId,
            {
              after: operationFailure.after,
              partialLine: operationFailure.partialLine,
              lines: operationFailure.lines,
              maxLineBytes: 1024 * 1024,
              maxLines: 1_000_000,
              pageLimit: 16,
              signal: abort.signal,
            },
            async (page) => {
              for (const value of page.values) {
                rows += 1;
                if (preview.length < 25) preview.push(value);
              }
              if (page.stderr.length > 0 && notices.length < 25) {
                notices.push(
                  new TextDecoder().decode(Uint8Array.from(page.stderr)).slice(0, 4_096),
                );
              }
            },
          );
          if (resumed.complete && resumed.execution.exit_code === 0) {
            process.stdout.write(`${JSON.stringify({ rows, preview, notices })}\n`);
            recovered = true;
          }
        } finally {
          if (leaseFailure) {
            await workspace(resumedSession).networks.disconnect(
              leaseFailure.networkId,
              leaseFailure.containerId,
            );
          }
          await resumedSession.close();
        }
      }
    }
    if (!recovered) throw error;
  } finally {
    clearTimeout(timer);
    if (executionId) await containers.removeExecution(executionId).catch(() => {});
  }
} finally {
  await session.close();
}
