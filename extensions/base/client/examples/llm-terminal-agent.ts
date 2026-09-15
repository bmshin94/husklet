import {
  SemanticActionOperationError,
  TerminalCommandOperationError,
  TerminalCommandStartOperationError,
  TerminalCommandStartProtocolError,
  TerminalOperationError,
  connect,
  workspace,
} from '@husklet/client';
declare const process: { argv: string[]; stdout: { write(value: string): void } };

type Configuration = {
  path: string;
  slot: string;
  prompt?: string;
  /** Exact interactive bytes, for example `[3]` for Ctrl-C. Never retried after reply loss. */
  rawInput?: number[];
  deadlineMs?: number;
  semanticAction?: {
    node: number;
    action: 'invoke' | 'change' | 'submit' | 'toggle' | 'expand' | 'focus';
    value?: string;
  };
};
const configuration = JSON.parse(process.argv[2] ?? 'null') as Configuration | null;
if (
  !configuration?.path ||
  !configuration.slot ||
  (!configuration.prompt && !configuration.rawInput && !configuration.semanticAction)
) {
  throw new TypeError(
    'usage: llm-terminal-agent.ts JSON(path, slot, prompt | rawInput | semanticAction)',
  );
}

const session = await connect({ path: configuration.path, pendingLimit: 8, timeout: 5_000 });
try {
  const terminal = workspace(session).terminal;
  const context = await terminal.readLayoutStable({ lines: 80, attempts: 3 });
  const contextIncomplete =
    !context.complete ||
    context.panes.some(({ readable }) => readable.kind === 'ui' && !readable.complete);
  const selected = context.panes.find(({ pane }) => pane.slot === configuration.slot);
  if (!selected) throw new Error('pane is not available in the bounded inventory');
  const observed = selected.readable;
  const panes = context.panes.map(({ pane, readable }) => ({
    slot: pane.slot,
    kind: readable.kind,
    text: readable.text,
  }));
  if (observed.kind === 'ui') {
    let actionResult;
    if (configuration.semanticAction) {
      try {
        actionResult = await terminal.actObservedAndWait(observed, configuration.semanticAction);
      } catch (cause) {
        if (!(cause instanceof SemanticActionOperationError)) throw cause;
        const resumedSession = await connect({
          path: configuration.path,
          pendingLimit: 8,
          timeout: 5_000,
        });
        try {
          const after = await workspace(resumedSession).terminal.semantics(configuration.slot);
          actionResult = {
            changed:
              after.generation === cause.action.generation &&
              after.revision > cause.action.revision,
            before: cause.before,
            after,
            replayed: false,
          };
        } finally {
          await resumedSession.close();
        }
      }
    }
    process.stdout.write(
      `${JSON.stringify({ layout: context.topology, context: panes, incomplete: contextIncomplete, selected: { kind: 'ui', text: observed.text, complete: observed.complete }, action: actionResult })}\n`,
    );
  } else {
    if (configuration.rawInput) {
      let inputResult;
      try {
        inputResult = await terminal.writeLiveObservedAndWaitForText(
          observed.snapshot,
          configuration.rawInput,
          { timeoutMs: configuration.deadlineMs ?? 2_000 },
        );
      } catch (cause) {
        if (
          !(cause instanceof TerminalOperationError) ||
          !('written' in cause.result) ||
          cause.result.written !== 'unknown' ||
          !cause.result.recovery
        ) {
          throw cause;
        }
        const recovery = JSON.parse(JSON.stringify(cause.result.recovery));
        const resumedSession = await connect({ path: configuration.path, timeout: 5_000 });
        try {
          inputResult = await workspace(resumedSession).terminal.reconcileWriteFailure(recovery);
          // Persist `recovery` before restarting: the host returns its receipt without typing twice.
        } finally {
          await resumedSession.close();
        }
      }
      process.stdout.write(`${JSON.stringify({ input: inputResult })}\n`);
    } else {
      const deadlineMs = configuration.deadlineMs ?? 2_000;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
        throw new RangeError('deadlineMs must be between 1 and 30000ms');
      }
      const cancellation = new AbortController();
      const deadline = setTimeout(
        () => cancellation.abort('agent interaction deadline'),
        deadlineMs,
      );
      try {
        let result;
        try {
          result = await terminal.commandText(observed.snapshot, {
            command: ['sh', '-lc', configuration.prompt!],
            maxBytes: 1024 * 1024,
            signal: cancellation.signal,
            cancelSignal: 'SIGINT',
            cancelTimeoutMs: 1_000,
          });
        } catch (cause) {
          const resumedSession = await connect({
            path: configuration.path,
            pendingLimit: 8,
            timeout: 5_000,
          });
          try {
            const resumedTerminal = workspace(resumedSession).terminal;
            if (cause instanceof TerminalCommandStartProtocolError) throw cause;
            if (cause instanceof TerminalCommandStartOperationError) {
              const command = await resumedTerminal.recoverCommandStart(cause);
              result = await resumedTerminal.resumeCommandText({
                version: 1,
                command,
                after: 0,
                stdout: [],
                stderr: [],
                maxBytes: 1024 * 1024,
              });
            } else if (cause instanceof TerminalCommandOperationError) {
              result = await resumedTerminal.resumeCommandText(cause.resume);
            } else {
              throw cause;
            }
          } finally {
            await resumedSession.close();
          }
        }
        process.stdout.write(
          `${JSON.stringify({ layout: context.topology, context: panes, incomplete: contextIncomplete, selected: { kind: 'terminal', before: observed.text, command: result.command.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.command.exit_code, completed: !result.command.running, pane: { slot: result.command.slot, generation: result.command.generation, revision: result.command.revision } } })}\n`,
        );
      } finally {
        clearTimeout(deadline);
      }
    }
  }
} finally {
  await session.close();
}
