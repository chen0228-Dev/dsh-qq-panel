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
/** Reference prefixes, aligned with the dsh-im channel-fault precedent. */
export const REF_PREFIXES = { conn: 'QQ-CONN-', msg: 'MF-' };
/** Random character count after the base36 timestamp. */
export const REF_RANDOM_CHARS = 4;
/** How many recent fault references the registry keeps (and the /healthcheck
 * report lists); bounded so a fault storm cannot grow memory. */
export const FAILURE_REF_MAX = 10;
/** Detail length cap for a stored record (the trace reason carries the full
 * text; the registry keeps a bounded excerpt). */
export const FAILURE_REF_DETAIL_MAX = 160;
/** Mint one reference number: `<prefix><base36 ms><4 random base36 chars>`.
 * Deterministic under injection (tests pass now/random); the default reads
 * the wall clock and Math.random. The reference carries no user content. */
export function newFailureRef(kind, options) {
    const now = Math.floor(options?.now ?? Date.now());
    const random = options?.random ?? Math.random;
    let tail = '';
    for (let i = 0; i < REF_RANDOM_CHARS; i++)
        tail += Math.floor(random() * 36).toString(36);
    return REF_PREFIXES[kind] + now.toString(36) + tail;
}
/** Whether a string is a well-formed reference number (used to validate the
 * `/healthcheck export <参考号>` argument before it reaches a file name). */
export function isFailureRef(value) {
    return /^(QQ-CONN-|MF-)[A-Za-z0-9]+$/.test(value);
}
/** The user-visible suffix appended to a fault notice's tail: the reference
 * plus the trace-file lookup hint. Empty when no reference exists (callers
 * mint one first on every fault path, so this only guards the plumbing). */
export function failureRefSuffix(ref) {
    return ref === undefined || ref === ''
        ? ''
        : '\n（参考号 ' + ref + '，可凭此号在 qq-trace.jsonl 中检索本次故障全过程）';
}
/**
 * The bounded in-memory registry of recent faults: the bridge records every
 * minted reference here and the /healthcheck report + diagnostics export read
 * the most recent entries. Capacity-bounded (oldest dropped); pure memory —
 * no disk writes, no persistence.
 */
export class FailureRefRegistry {
    capacity;
    items = [];
    constructor(capacity = FAILURE_REF_MAX) {
        this.capacity = capacity;
    }
    /** Mint one reference of the given kind (delegates to newFailureRef). */
    mint(kind, options) {
        return newFailureRef(kind, options);
    }
    /** Record one minted fault (detail bounded to FAILURE_REF_DETAIL_MAX);
     * drops the oldest record beyond the capacity. */
    record(record) {
        this.items.push({ ...record, detail: record.detail.slice(0, FAILURE_REF_DETAIL_MAX) });
        while (this.items.length > this.capacity)
            this.items.shift();
    }
    /** The most recent `count` records, oldest first (file/report order). */
    recent(count = this.capacity) {
        return this.items.slice(-Math.max(0, count));
    }
    /** Test/diagnostic snapshot. */
    snapshot() {
        return [...this.items];
    }
}
