import {
  ExtensionError,
  PostgresOperationProtocolError,
  PostgresCloseOperationError,
  PostgresPagesOperationError,
  connect,
  workspace,
} from '@husklet/client';

declare const process: {
  argv: string[];
  stdout: { write(value: string): void };
};

type Configuration = {
  path: string;
  openOperation: string;
  queryOperation: string;
  containerId: string;
  containerGeneration: number;
  network: string;
  database: string;
  user: string;
  passwordCredential: string;
  statement: string;
  maxRows?: number;
  maxPages?: number;
};

const configuration = JSON.parse(process.argv[2] ?? 'null') as Configuration | null;
const maxRows = configuration?.maxRows ?? 1_000_000;
const maxPages = configuration?.maxPages ?? 4_096;
if (
  !configuration?.path ||
  !configuration.openOperation ||
  !configuration.queryOperation ||
  !configuration.containerId ||
  !Number.isSafeInteger(configuration.containerGeneration) ||
  !configuration.network ||
  !configuration.database ||
  !configuration.user ||
  !configuration.passwordCredential ||
  !configuration.statement ||
  !Number.isSafeInteger(maxRows) ||
  maxRows < 1 ||
  maxRows > 1_000_000 ||
  !Number.isSafeInteger(maxPages) ||
  maxPages < 1 ||
  maxPages > 1_000_000
) {
  throw new TypeError('invalid PostgreSQL browser configuration');
}

let session = await connect({ path: configuration.path, pendingLimit: 4, timeout: 5_000 });
let host = workspace(session);
async function retryAfterDisconnect<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ExtensionError || error instanceof PostgresOperationProtocolError) {
      throw error;
    }
    await session.close().catch(() => {});
    session = await connect({ path: configuration!.path, pendingLimit: 4, timeout: 5_000 });
    host = workspace(session);
    return operation();
  }
}

async function closeRecoverably(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof PostgresCloseOperationError)) throw error;
    const recovery = JSON.parse(JSON.stringify(error.recovery));
    await session.close().catch(() => {});
    session = await connect({ path: configuration!.path, pendingLimit: 4, timeout: 5_000 });
    host = workspace(session);
    await host.postgres.recoverClose(recovery);
  }
}

const connection = {
  container_id: configuration.containerId,
  container_generation: configuration.containerGeneration,
  network: configuration.network,
  port: 5432,
  database: configuration.database,
  user: configuration.user,
  // Only this name crosses the socket. Husklet resolves the password inside the host broker.
  credential_keys: [configuration.passwordCredential],
};
const opened = await retryAfterDisconnect(() =>
  host.postgres.openOnce(configuration.openOperation, connection),
);
const query = {
  operation: configuration.queryOperation,
  statement: configuration.statement,
  page_rows: 250,
  page_bytes: 512 * 1024,
};
const started = await retryAfterDisconnect(() => host.postgres.startOnce(opened.lease, query));

let rowCount = 0;
let columns: string[] = [];
const preview: Array<Array<string | null>> = [];
let pages = host.postgres.pages(opened.lease, started.query, { maxPages });
let incomplete = true;
try {
  while (incomplete && rowCount < maxRows) {
    let item;
    try {
      item = await pages.next();
    } catch (error) {
      if (!(error instanceof PostgresPagesOperationError)) throw error;
      const recovery = JSON.parse(JSON.stringify(error.resume));
      await session.close().catch(() => {});
      session = await connect({ path: configuration.path, pendingLimit: 4, timeout: 5_000 });
      host = workspace(session);
      pages = host.postgres.resumePages(recovery, { maxPages });
      continue;
    }
    if (item.done) {
      incomplete = false;
      break;
    }
    const page = item.value;
    columns = page.columns;
    const accepted = page.rows.slice(0, maxRows - rowCount);
    rowCount += accepted.length;
    preview.push(...accepted.slice(0, Math.max(0, 25 - preview.length)));
  }
  if (incomplete) await host.postgres.cancel(opened.lease, started.query);
  process.stdout.write(`${JSON.stringify({ columns, rowCount, preview })}\n`);
} finally {
  await closeRecoverably(() => host.postgres.closeQueryRecoverable(opened.lease, started.query));
  await closeRecoverably(() => host.postgres.closeLeaseRecoverable(opened.lease));
  await session.close();
}
