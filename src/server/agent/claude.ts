import type { Intent } from "../types";
import { store } from "../state/store";
import { cashSignature, planTreasury } from "./planner";
import { getEngine } from "../runtime";

/**
 * Optional model layer.
 *
 * If ANTHROPIC_API_KEY is present the agent proposes intents through Claude. If
 * it is not, the deterministic planner is used and the product still works
 * end to end. Either way the output is parsed into the same narrow shape and
 * handed to the engine, which does not care who wrote it.
 *
 * This file is deliberately the thinnest layer in the repository. The claim of
 * the project is that the model is not trusted with money, so the model
 * integration should look unimportant. It is supposed to.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
const KINDS = ["fund", "convert", "defer", "escalate", "replace_transfer"] as const;

export function agentMode(): "claude" | "deterministic" {
  return process.env.ANTHROPIC_API_KEY ? "claude" : "deterministic";
}

interface RawProposal {
  kind?: string;
  obligationId?: string;
  currency?: string;
  to?: string;
  amount?: number;
  reason?: string;
  confidence?: number;
  requestId?: string;
  onBehalfOf?: string;
}

export async function proposeWithClaude(): Promise<{ intents: Intent[]; notes: string[] }> {
  const state = store.get();
  const engine = getEngine();

  const prompt = [
    "You are the treasury proposer for a company that cannot cover every near term obligation.",
    "Read the balances, reserve floors and obligations. Propose the minimum set of intents that resolves the book.",
    "Allowed kinds: fund, convert, defer, escalate, replace_transfer.",
    "defer uses amount = number of days. fund and convert use amount = major currency units.",
    "You may propose. You cannot execute. Every intent is checked by a policy engine that does not read your reason.",
    "Return JSON only: an array of objects with keys kind, obligationId, currency, to, amount, reason, confidence, requestId, onBehalfOf.",
    "requestId must be unique per intent and must never be reused across obligations.",
    "",
    "BALANCES " + JSON.stringify(state.wallets),
    "RESERVE_FLOORS " + JSON.stringify(engine.policy.reserveFloors),
    "AUTO_EXECUTE_CAP " + engine.policy.maxSinglePayout,
    "APPROVED_PAYEES " + JSON.stringify(engine.policy.approvedBeneficiaries),
    "OBLIGATIONS " + JSON.stringify(state.obligations),
    "OPEN_TRANSFERS " + JSON.stringify(state.transfers),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic call failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? []).map((c) => c.text ?? "").join("");
  const parsed = extractJsonArray(text);

  const intents: Intent[] = [];
  const notes: string[] = [];

  parsed.forEach((raw, index) => {
    const validated = validate(raw, index);
    if (typeof validated === "string") {
      notes.push(`dropped proposal ${index}: ${validated}`);
      return;
    }
    intents.push(validated);
  });

  return { intents, notes };
}

function extractJsonArray(text: string): RawProposal[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? (value as RawProposal[]) : [];
  } catch {
    return [];
  }
}

/**
 * Anything malformed never reaches the engine. The engine would reject it
 * anyway, but dropping it here keeps a hallucinated payee out of the audit
 * trail rather than in it.
 */
function validate(raw: RawProposal, index: number): Intent | string {
  if (!raw.kind || !KINDS.includes(raw.kind as (typeof KINDS)[number])) return `unknown kind ${raw.kind}`;
  if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount <= 0) return "amount missing or non positive";
  if (!raw.currency || typeof raw.currency !== "string") return "currency missing";

  const state = store.get();
  if (raw.obligationId && !state.obligations.some((o) => o.id === raw.obligationId)) {
    return `obligation ${raw.obligationId} does not exist`;
  }
  if (raw.kind === "fund" || raw.kind === "replace_transfer") {
    const obligation = state.obligations.find((o) => o.id === raw.obligationId);
    if (!obligation) return "payout with no obligation attached";
    if (!engineAllowsPayee(obligation.beneficiaryId)) return `payee ${obligation.beneficiaryId} is not on the allowlist`;
  }

  return {
    id: `int_llm_${Date.now().toString(36)}_${index}`,
    kind: raw.kind as Intent["kind"],
    obligationId: raw.obligationId,
    currency: raw.currency.toUpperCase(),
    to: raw.to?.toUpperCase(),
    amount: raw.amount,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 600) : "(no reason given)",
    confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
    requestId: raw.requestId ?? `req_llm_${Date.now().toString(36)}_${index}`,
    onBehalfOf: raw.onBehalfOf,
  };
}

function engineAllowsPayee(beneficiaryId: string): boolean {
  return getEngine().policy.approvedBeneficiaries.includes(beneficiaryId);
}

/**
 * Single entry point the API routes call. Falls back to the deterministic
 * planner if Claude is unavailable or errors, and says so out loud rather than
 * pretending the model ran.
 */
export async function propose(reopenOnly?: string): Promise<{ intents: Intent[]; source: "claude" | "deterministic"; notes: string[]; signature: string }> {
  const engine = getEngine();
  const state = store.get();

  if (agentMode() === "claude") {
    try {
      const { intents, notes } = await proposeWithClaude();
      if (intents.length) {
        return { intents, source: "claude", notes, signature: cashSignature(state, engine.policy) };
      }
      return {
        ...(await deterministic(reopenOnly)),
        notes: ["Claude returned no usable proposals. Used the deterministic allocator."],
      };
    } catch (error) {
      return {
        ...(await deterministic(reopenOnly)),
        notes: [`Claude unavailable (${error instanceof Error ? error.message : "unknown"}). Used the deterministic allocator.`],
      };
    }
  }
  return deterministic(reopenOnly);
}

async function deterministic(reopenOnly?: string): Promise<{ intents: Intent[]; source: "deterministic"; notes: string[]; signature: string }> {
  const engine = getEngine();
  const state = store.get();
  const plan = await planTreasury(engine.gateway, state, engine.policy, reopenOnly);
  state.pendingIntents = plan.intents;
  return {
    intents: plan.intents,
    source: "deterministic",
    notes: plan.pinned.map((p) => `${p.payee}: ${p.reason}`),
    signature: plan.signature,
  };
}
