export { ExtensionError, RowReplyMismatchError, RowRequestUnavailableError, Session, DATA, SOCKET, PROTOCOL, validateRowRequest, validateUiEvent, } from './session.js';
export { PROTOCOL_SPECIFICATION_VERSION, PROTOCOL_VERSION, PROTOCOL_BOUNDS, PROTOCOL_CAPABILITIES, PROTOCOL_TOPICS, PROTOCOL_REPLIES, PROTOCOL_REQUEST_CAPABILITIES, encodeRequest, validateRequest, validateReply, validateReplyFor, validateFailure, validateSnapshot, } from './generated-protocol.js';
import { semanticText, semanticXml } from './semantic.js';
export { semanticText, semanticXml };
import type { CallOptions, ConnectOptions, PaneText, Session as ClientSession, WorkspaceApi } from './api.js';
/** A supervised input reply was lost; retry this exact operation and offset safely. */
export declare class TerminalCommandInputOperationError extends Error {
    readonly command: any;
    readonly operation: any;
    readonly offset: any;
    readonly input: any;
    readonly close: any;
    readonly cause: any;
    constructor(command: any, operation: any, offset: any, input: any, close: any, cause: any);
}
/** A supervised command creation reply was lost; retry the exact token safely. */
export declare class TerminalCommandStartOperationError extends Error {
    readonly pane: any;
    readonly command: any;
    readonly operation: any;
    readonly workingDirectory: any;
    readonly stdin: any;
    readonly cause: any;
    constructor(pane: any, command: any, operation: any, workingDirectory: any, stdin: any, cause: any);
}
/** The host acknowledged a start token with a different command request. */
export declare class TerminalCommandStartProtocolError extends Error {
    readonly expected: any;
    readonly received: any;
    constructor(expected: any, received: any);
}
/** The host returned a PostgreSQL page for a different lease, query, or cursor. */
export declare class PostgresPageProtocolError extends Error {
    readonly lease: any;
    readonly query: any;
    readonly cursor: any;
    readonly receivedLease: any;
    readonly receivedQuery: any;
    readonly receivedCursor: any;
    constructor(lease: any, query: any, cursor: any, receivedLease: any, receivedQuery: any, receivedCursor: any);
}
/** The host returned database state for another lease or query. */
export declare class PostgresStateProtocolError extends Error {
    readonly expectedLease: any;
    readonly expectedQuery: any;
    readonly receivedLease: any;
    readonly receivedQuery: any;
    constructor(expectedLease: any, expectedQuery: any, receivedLease: any, receivedQuery: any);
}
/** The host returned database authority for another operation or lease. */
export declare class PostgresOperationProtocolError extends Error {
    readonly phase: any;
    readonly expectedOperation: any;
    readonly receivedOperation: any;
    readonly expectedLease: any;
    readonly receivedLease: any;
    constructor(phase: any, expectedOperation: any, receivedOperation: any, expectedLease: any, receivedLease: any);
}
/** A credential CAS write may have committed before its revision reply was lost. */
export declare class CredentialSetOperationError extends Error {
    readonly key: any;
    readonly observed: any;
    readonly value: any;
    constructor(key: any, observed: any, value: any, cause: any);
}
/** The host returned non-secret credential authority for another key or revision. */
export declare class CredentialWriteProtocolError extends Error {
    readonly expected: any;
    readonly received: any;
    constructor(expected: any, received: any);
}
/** The host returned an idempotent container result for another operation token. */
export declare class ContainerCreateOnceProtocolError extends Error {
    readonly expectedToken: any;
    readonly receivedToken: any;
    constructor(expectedToken: any, receivedToken: any);
}
/** The host returned an image-pull job for another image reference. */
export declare class ImagePullStartProtocolError extends Error {
    readonly expectedReference: any;
    readonly receivedReference: any;
    constructor(expectedReference: any, receivedReference: any);
}
/** The host returned image-pull status for another job or reference. */
export declare class ImagePullStatusProtocolError extends Error {
    readonly expected: any;
    readonly received: any;
    constructor(expected: any, received: any);
}
/** A credential removal may have committed before its reply was lost. */
export declare class CredentialRemoveOperationError extends Error {
    readonly key: any;
    readonly observed: any;
    constructor(key: any, observed: any, cause: any);
}
/** An extension install/update may have committed before its reply was lost. */
export declare class ExtensionCommitOperationError extends Error {
    readonly operation: any;
    readonly job: any;
    readonly revision: any;
    readonly candidate: any;
    readonly review: any;
    constructor(operation: any, job: any, revision: any, candidate: any, review: any, cause: any);
}
/** An exact extension removal may have committed before its reply was lost. */
export declare class ExtensionRemoveOperationError extends Error {
    readonly extensionName: any;
    readonly imageDigest: any;
    constructor(name: any, imageDigest: any, cause: any);
}
/** A post-creation execution failure whose immutable identity remains recoverable. */
export declare class ExecutionOperationError extends Error {
    readonly executionId: any;
    readonly phase: any;
    readonly execution: any;
    readonly containerId: any;
    readonly after: any;
    readonly partialLine: any;
    readonly lines: any;
    readonly stdout: any;
    readonly stderr: any;
    constructor(executionId: any, phase: any, cause: any, execution?: any, after?: any, recovery?: any);
}
/** An execution may have started before its identity reply was lost. */
export declare class ExecutionStartOperationError extends Error {
    readonly containerId: any;
    readonly generation: any;
    readonly command: any;
    readonly credentialKeys: any;
    readonly before: any;
    constructor(containerId: any, generation: any, command: any, credentialKeys: any, before: any, cause: any);
}
/** The host associated an execution identity with a container other than the selected target. */
export declare class ExecutionContainerMismatchError extends Error {
    readonly executionId: any;
    readonly expectedContainerId: any;
    readonly actualContainerId: any;
    constructor(executionId: any, expectedContainerId: any, actualContainerId: any);
}
/** A client-owned execution exceeded its post-start wall-clock deadline. */
export declare class ExecutionDeadlineError extends Error {
    readonly executionId: any;
    readonly deadlineMs: any;
    constructor(executionId: any, deadlineMs: any);
}
/** A temporary network lease could not be released; its exact cleanup authority is recoverable. */
export declare class TemporaryNetworkConnectionError extends Error {
    readonly networkId: any;
    readonly containerId: any;
    readonly operation: any;
    readonly cleanup: any;
    constructor(networkId: any, containerId: any, operation: any, cleanup: any);
}
/** A network attach may have committed before its reply was lost. */
export declare class TemporaryNetworkConnectionAcquisitionError extends Error {
    readonly networkId: any;
    readonly containerId: any;
    readonly acquisition: any;
    constructor(networkId: any, containerId: any, acquisition: any);
}
/** Output retention advanced past the cursor, so a transcript/result would be incomplete. */
export declare class ExecutionOutputGapError extends Error {
    readonly executionId: any;
    readonly after: any;
    readonly next: any;
    constructor(executionId: any, after: any, next: any);
}
/** Output reached EOF while the exact execution still reported itself running. */
export declare class ExecutionOutputEndedEarlyError extends Error {
    readonly executionId: any;
    constructor(executionId: any);
}
/** The host returned an internally inconsistent output page, so iteration cannot continue safely. */
export declare class ExecutionOutputProtocolError extends Error {
    readonly executionId: any;
    readonly after: any;
    readonly next: any;
    constructor(executionId: any, after: any, next: any, detail: any);
}
/** One bounded structured-output record was not valid JSON. */
export declare class JsonLineParseError extends SyntaxError {
    readonly line: any;
    constructor(line: any, cause: any);
}
/** One syntactically valid JSON record did not satisfy the consumer's result schema. */
export declare class JsonLineDecodeError extends TypeError {
    readonly line: any;
    constructor(line: any, cause: any);
}
/** Durable JSON state could not be decoded; its exact identity remains available for CAS recovery. */
export declare class StateDecodeError extends TypeError {
    readonly identity: any;
    constructor(identity: any, cause: any);
}
/** A JSON state write lost its outcome; exact CAS authority and candidate bytes are recoverable. */
export declare class StateWriteOperationError extends Error {
    readonly observed: any;
    readonly contents: any;
    constructor(observed: any, contents: any, cause: any);
}
/** The host returned checkpoint authority for another prior state generation. */
export declare class StateWriteProtocolError extends Error {
    readonly expectedObserved: any;
    readonly received: any;
    constructor(expectedObserved: any, received: any);
}
/** A file CAS write lost its outcome; exact path, identity, and candidate bytes are recoverable. */
export declare class FileWriteOperationError extends Error {
    readonly path: any;
    readonly observed: any;
    readonly contents: any;
    constructor(path: any, observed: any, contents: any, cause: any);
}
/** The host returned a file-write identity for another path or prior generation. */
export declare class FileWriteProtocolError extends Error {
    readonly expected: any;
    readonly received: any;
    constructor(expected: any, received: any);
}
/** Catalogue discovery was bounded before it became a complete searchable set. */
export declare class IncompleteCatalogueError extends Error {
    readonly received: any;
    constructor(received: any);
}
/** A terminal authority succeeded, but its bounded observation could not be completed. */
export declare class TerminalOperationError extends Error {
    readonly operation: any;
    readonly result: any;
    constructor(operation: any, result: any, cause: any);
}
/** Durable authority for reconciling one terminal input whose reply was lost. */
export interface TerminalInputRecoveryToken {
    readonly version: 1;
    readonly slot: string;
    readonly generation: number;
    readonly revision: number;
    readonly writer: string;
    readonly sequence: number;
    readonly input: readonly number[];
}
/** An observed pane close may have committed before its reply was lost. */
export declare class TerminalCloseOperationError extends Error {
    readonly slot: any;
    readonly generation: any;
    readonly revision: any;
    constructor(slot: any, generation: any, revision: any, cause: any);
}
/** A tab pin/unpin may have committed before its reply was lost. */
export declare class TerminalPinOperationError extends Error {
    readonly tab: any;
    readonly pinned: any;
    constructor(tab: any, pinned: any, cause: any);
}
/** The host returned idempotent tab authority for another operation token. */
export declare class TerminalOpenTabOnceProtocolError extends Error {
    readonly expectedToken: any;
    readonly receivedToken: any;
    constructor(expectedToken: any, receivedToken: any);
}
/** A revision-bound semantic action may have committed before observation failed. */
export declare class SemanticActionOperationError extends Error {
    readonly before: any;
    readonly action: any;
    readonly observed: any;
    constructor(before: any, action: any, observed: any, cause: any);
}
/** History reply no longer belongs to the exact pane snapshot selected by the caller. */
export declare class TerminalHistoryChangedError extends Error {
    readonly observed: any;
    readonly received: any;
    constructor(observed: any, received: any);
}
/** A supervised terminal command failed after creation, retaining exact recovery state. */
export declare class TerminalCommandOperationError extends Error {
    readonly command: any;
    readonly phase: any;
    readonly after: any;
    readonly stdout: any;
    readonly stderr: any;
    readonly resume: any;
    constructor(command: any, phase: any, after: any, cause: any, output?: any, maxBytes?: any);
}
/** A terminal text request cannot be represented by the host's bounded pane tail. */
export declare class TerminalReadLimitError extends RangeError {
    readonly requested: any;
    readonly maximum: any;
    constructor(requested: any, maximum?: number);
}
/** A pane advanced or was replaced between discovery and its bounded text projection. */
export declare class PaneChangedError extends Error {
    readonly slot: any;
    readonly expected: any;
    readonly observed: any;
    constructor(slot: any, expected: any, observed: any);
}
/** The pane layout kept changing while a bounded coherent inventory was assembled. */
export declare class PaneInventoryChangedError extends Error {
    readonly attempts: any;
    readonly before: any;
    readonly after: any;
    constructor(attempts: any, before: any, after: any);
}
/** Tab topology changed while its pane contents were being converted to text. */
export declare class TerminalLayoutChangedError extends Error {
    readonly attempts: any;
    readonly before: any;
    readonly after: any;
    constructor(attempts: any, before: any, after: any);
}
/** Bounded pane discovery omitted identities, so whole-layout stability cannot be proven. */
export declare class IncompletePaneInventoryError extends Error {
    readonly panes: any;
    constructor(panes: any);
}
/** A requested pane is absent or cannot be resolved from a bounded inventory. */
export declare class PaneUnavailableError extends Error {
    readonly slot: any;
    readonly reason: any;
    constructor(slot: any, reason: any);
}
/** Input was intentionally withheld because the observed terminal has no live child process. */
export declare class TerminalNotLiveError extends Error {
    readonly snapshot: PaneText;
    constructor(snapshot: PaneText);
}
/** Filesystem history rotated before an incremental consumer could resume its cursor. */
export declare class FilesystemJournalGapError extends Error {
    readonly requested: any;
    readonly replacement: any;
    constructor(requested: any, replacement: any);
}
/** A directory page crossed generations and enumeration must restart from its root. */
export declare class DirectoryIdentityChangedError extends Error {
    readonly path: any;
    readonly expected: any;
    readonly actual: any;
    readonly after: any;
    constructor(path: any, expected: any, actual: any, after: any);
}
/** One exact file generation could not be decoded as UTF-8. */
export declare class FileTextDecodeError extends TypeError {
    readonly path: any;
    readonly identity: any;
    readonly bytes: any;
    constructor(path: any, identity: any, bytes: any, cause: any);
}
/** One exact file generation exceeded the caller-owned text collection bound. */
export declare class FileTextLimitError extends RangeError {
    readonly path: any;
    readonly identity: any;
    readonly total: any;
    readonly limit: any;
    constructor(path: any, identity: any, total: any, limit: any);
}
/** A chunk stream reached its caller-owned work bound with an exact resume cursor. */
export declare class FileChunkLimitError extends RangeError {
    readonly path: any;
    readonly identity: any;
    readonly offset: any;
    readonly total: any;
    readonly maxBytes: any;
    readonly maxChunks: any;
    constructor(path: any, identity: any, offset: any, total: any, maxBytes: any, maxChunks: any);
}
/** A chunk stream lost transport or was cancelled after establishing an exact resume cursor. */
export declare class FileChunkOperationError extends Error {
    readonly path: any;
    readonly identity: any;
    readonly offset: any;
    readonly total: any;
    readonly deliveredBytes: any;
    readonly deliveredChunks: any;
    readonly maxBytes: any;
    readonly maxChunks: any;
    readonly resume: any;
    constructor(path: any, identity: any, offset: any, total: any, deliveredBytes: any, deliveredChunks: any, maxBytes: any, maxChunks: any, cause: any);
}
/** A bounded text read lost transport after an exact prefix had been acknowledged. */
export declare class FileTextOperationError extends Error {
    readonly path: any;
    readonly identity: any;
    readonly contents: any;
    readonly maxBytes: any;
    constructor(path: any, identity: any, contents: any, maxBytes: any, cause: any);
}
/** A ranged read crossed file generations and must be restarted from a coherent identity. */
export declare class FileIdentityChangedError extends Error {
    readonly path: any;
    readonly expected: any;
    readonly actual: any;
    readonly offset: any;
    constructor(path: any, expected: any, actual: any, offset: any);
}
/** One identity reported contradictory file extents across ranged reads. */
export declare class FileExtentChangedError extends Error {
    readonly path: any;
    readonly identity: any;
    readonly expectedTotal: any;
    readonly actualTotal: any;
    readonly offset: any;
    constructor(path: any, identity: any, expectedTotal: any, actualTotal: any, offset: any);
}
export declare function connect(options?: ConnectOptions): Promise<ClientSession>;
/**
 * Opens a surface and paints a dependency-free first frame.
 *
 * Extensions can do this before importing React or another renderer, keeping
 * cold-start feedback independent of framework initialization. Pass the
 * returned token to the renderer so it continues the same frame sequence.
 */
export declare function bootstrapSurface(session: any, { title, label, primary }?: {
    title?: string;
    label?: string;
    primary?: boolean;
}): Promise<Readonly<{
    slot: string;
    sequence: 1;
    nextNode: 2;
    bootstrapNode: 1;
}>>;
export declare function workspace(session: ClientSession, { signal }?: CallOptions): WorkspaceApi;
/** Mirrors Rust Request::capability for every fixed wire call used by this public facade. */
export declare function requestCapability(call: any): any;
/** Schema-derived inventory connecting every Rust request/topic to its supported public route. */
export declare const protocolSurface: Readonly<{
    requests: any;
    topics: Readonly<{
        [k: string]: Readonly<{
            subscribe: "subscribe";
            unsubscribe: "unsubscribe";
        }>;
    }>;
}>;
/** Honest inventory of the current host contract; gaps are not callable APIs. */
export declare const protocolCoverage: Readonly<{
    available: Readonly<{
        workspace: string[];
        containers: string[];
        images: string[];
        volumes: string[];
        networks: string[];
        terminal: string[];
        files: string[];
        state: string[];
        preferences: string[];
        extensions: string[];
        notifications: string[];
        interfaceEvents: string[];
        workspaceEvents: string[];
        snapshotTopics: readonly string[];
    }>;
    unavailable: Readonly<{
        workspace: string[];
        containers: any[];
        images: any[];
        terminal: any[];
        events: any[];
        extensions: any[];
    }>;
}>;
