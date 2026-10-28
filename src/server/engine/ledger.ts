import { createHash } from "node:crypto";
import type { LedgerRecord } from "../types";

/**
 * Append only, hash chained decision ledger.
 *
 * Every record carries the hash of the record before it, so the log a judge
 * reads after a demo is the same log that was written during it. Editing one
 * entry in place invalidates every hash after it, and `verify` says so and
 * where.
 *
 * This matters because the whole claim of the product is that an agent's money
 * actions are auditable. A log the agent can rewrite is not one.
 */

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function hashOf(prevHash: string, seq: number, ts: string, kind: string, payload: unknown): string {
  const digest = createHash("sha256");
  digest.update(prevHash);
  digest.update("|");
  digest.update(String(seq));
  digest.update("|");
  digest.update(ts);
  digest.update("|");
  digest.update(kind);
  digest.update("|");
  digest.update(canonical(payload));
  return digest.digest("hex");
}

export class DecisionLedger {
  private records: LedgerRecord[] = [];

  append(kind: LedgerRecord["kind"], payload: unknown): LedgerRecord {
    const prevHash = this.records.length ? this.records[this.records.length - 1].hash : GENESIS;
    const seq = this.records.length + 1;
    const ts = new Date().toISOString();
    const hash = hashOf(prevHash, seq, ts, kind, payload);
    const record: LedgerRecord = { seq, ts, kind, payload, prevHash, hash };
    this.records.push(record);
    return record;
  }

  all(): LedgerRecord[] {
    return [...this.records];
  }

  get length(): number {
    return this.records.length;
  }

  /** Recompute the chain and report the first divergence, if any. */
  verify(): { ok: boolean; length: number; brokenAt?: number; expected?: string; found?: string } {
    let prevHash = GENESIS;
    for (const record of this.records) {
      const expected = hashOf(prevHash, record.seq, record.ts, record.kind, record.payload);
      if (expected !== record.hash || record.prevHash !== prevHash) {
        return {
          ok: false,
          length: this.records.length,
          brokenAt: record.seq,
          expected,
          found: record.hash,
        };
      }
      prevHash = record.hash;
    }
    return { ok: true, length: this.records.length };
  }

  /**
   * Proof that the chain is not merely decorative. Returns a copy with one
   * payload mutated, used by the UI to show verification actually failing.
   */
  tamperedCopy(fieldPath: string): DecisionLedger {
    const clone = new DecisionLedger();
    clone.records = this.records.map((r) => ({ ...r }));
    const target = clone.records[Math.min(2, clone.records.length - 1)];
    if (target) {
      target.payload = { __tampered: fieldPath, ...(target.payload as object) };
    }
    return clone;
  }
}

export const GENESIS = "0".repeat(64);
