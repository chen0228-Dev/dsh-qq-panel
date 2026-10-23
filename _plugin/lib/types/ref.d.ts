/**
 * Diagnostic failure references (W3/T4, P3): one fault, one reference number.
 * Connection/bridge faults mint `QQ-CONN-<ts><rand>`; message-turn faults mint
 * `MF-<ts><rand>` (format aligned with the dsh-im `WX-CONN-…`/`MF-…`
 * precedent, research/dsh-im-readme-fetched.md 诊断段). The same reference is
 * carried by every surface of one fault: the structured log line, the trace
 * event (`data.ref`), the user-visible error notice tail, and the
 * /healthcheck report + diagnostics archive file name — so a user can grep
 * mediaDir/qq-trace.jsonl for the whole fault's decision trail.
 *
 * Safety posture (plan R8): references are minted ONLY on fault events —
 * normal traffic pays zero cost and generates zero references; a reference
 * itself contains nothing but a base36 timestamp and random characters (no
 * user content ever enters a reference).
 * @module dsh-onebot/ref
 */
/** Which fault class a reference belongs to. */
export type FailureRefKind = 'conn' | 'msg';
/** Reference prefixes, aligned with the dsh-im channel-fault precedent. */
export declare const REF_PREFIXES: Record<FailureRefKind, string>;
/** Random character count after the base36 timestamp. */
export declare const REF_RANDOM_CHARS = 4;
/** How many recent fault references the registry keeps (and the /healthcheck
 * report lists); bounded so a fault storm cannot grow memory. */
export declare const FAILURE_REF_MAX = 10;
/** Detail length cap for a stored record (the trace reason carries the full
 * text; the registry keeps a bounded excerpt). */
export declare const FAILURE_REF_DETAIL_MAX = 160;
/** One recorded fault: the reference and everything needed to locate it. */
export interface FailureRefRecord {
    ref: string;
    kind: FailureRefKind;
    /** Epoch ms when the fault was minted. */
    ts: number;
    /** Trace stage (or a connection-fault stage name) for the report line. */
    stage: string;
    /** Short Chinese fault description (bounded; no user message bodies). */
    detail: string;
    /** The message's traceId when the fault happened inside a traced chat. */
    traceId?: string;
}
/** Mint one reference number: `<prefix><base36 ms><4 random base36 chars>`.
 * Deterministic under injection (tests pass now/random); the default reads
 * the wall clock and Math.random. The reference carries no user content. */
export declare function newFailureRef(kind: FailureRefKind, options?: {
    now?: number;
    random?: () => number;
}): string;
/** Whether a string is a well-formed reference number (used to validate the
 * `/healthcheck export <参考号>` argument before it reaches a file name). */
export declare function isFailureRef(value: string): boolean;
/** The user-visible suffix appended to a fault notice's tail: the reference
 * plus the trace-file lookup hint. Empty when no reference exists (callers
 * mint one first on every fault path, so this only guards the plumbing). */
export declare function failureRefSuffix(ref: string | undefined): string;
/**
 * The bounded in-memory registry of recent faults: the bridge records every
 * minted reference here and the /healthcheck report + diagnostics export read
 * the most recent entries. Capacity-bounded (oldest dropped); pure memory —
 * no disk writes, no persistence.
 */
export declare class FailureRefRegistry {
    private readonly capacity;
    private readonly items;
    constructor(capacity?: number);
    /** Mint one reference of the given kind (delegates to newFailureRef). */
    mint(kind: FailureRefKind, options?: {
        now?: number;
        random?: () => number;
    }): string;
    /** Record one minted fault (detail bounded to FAILURE_REF_DETAIL_MAX);
     * drops the oldest record beyond the capacity. */
    record(record: FailureRefRecord): void;
    /** The most recent `count` records, oldest first (file/report order). */
    recent(count?: number): FailureRefRecord[];
    /** Test/diagnostic snapshot. */
    snapshot(): FailureRefRecord[];
}
