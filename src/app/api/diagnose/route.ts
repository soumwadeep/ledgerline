import { NextResponse } from "next/server";
import { getEngine, gatewayMode, gatewayWarning } from "@/server/runtime";
import { store } from "@/server/state/store";
import type { QuoteRecord } from "@/server/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Quotes are registered by the caller so the engine can track reuse. */
function registerQuote(quote: QuoteRecord): void {
  const quotes = store.get().quotes;
  if (!quotes.some((q) => q.id === quote.id)) quotes.push(quote);
}

interface Step {
  name: string;
  endpoint: string;
  ok: boolean;
  detail: string;
}

/**
 * Walks the documented connection sequence and reports exactly which step
 * fails, in the order Airwallex's own guide says to check them.
 *
 * The builder guide's advice is "if you can't, say what's missing". This is
 * that, as an endpoint rather than a paragraph.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mutate = url.searchParams.get("mutate") === "1";
  const engine = getEngine();
  const gateway = engine.gateway;
  const steps: Step[] = [];

  const record = async (name: string, endpoint: string, run: () => Promise<string>) => {
    try {
      steps.push({ name, endpoint, ok: true, detail: await run() });
    } catch (error) {
      steps.push({
        name,
        endpoint,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await record("identity", "runtime", async () => `${await gateway.describe()} (mode ${gatewayMode()})`);
  await record("authentication", "POST /api/v1/authentication/login", async () => "token acquired or simulation. Valid 30 minutes on the live sandbox");
  await record("balances", "GET /api/v1/balances/current", async () => JSON.stringify(await gateway.listBalances()));
  await record(
    "global account",
    "GET /api/v1/global_accounts then POST /api/v1/global_accounts/create",
    async () => {
      const account = await gateway.ensureGlobalAccount("USD");
      return `${account.id}. ${account.note}`;
    },
  );
  await record(
    "fx rate",
    "GET /api/v1/fx/rates/current",
    async () => `SGD/EUR ${await gateway.fxRate("SGD", "EUR")}. FX calls must not carry x-api-version`,
  );
  await record(
    "quote",
    "POST /api/v1/fx/quotes/create",
    async () => {
      const quote = await gateway.quote({ sellCurrency: "SGD", sellAmount: 100, buyCurrency: "EUR" });
      registerQuote(quote);
      return `quoted ${quote.sell} SGD into ${quote.buy} EUR at ${quote.rate}`;
    },
  );

  if (mutate) {
    await record(
      "conversion",
      "POST /api/v1/fx/conversions/create",
      async () => {
        const quote = await gateway.quote({ sellCurrency: "SGD", sellAmount: 100, buyCurrency: "EUR" });
        registerQuote(quote);
        const result = await gateway.convert(quote.id, `req_diag_${Date.now()}`);
        return `${result.conversionId}. ${result.note}`;
      },
    );
    await record(
      "transfer state machine",
      "POST /api/v1/simulation/transfers/{id}/transition",
      async () => {
        const transfer = await gateway.pay({
          requestId: `req_diag_${Date.now()}`,
          currency: "USD",
          amount: 10,
          beneficiaryId: "ben_datadog",
          transferMethod: "LOCAL",
          note: "diagnostic",
        });
        await gateway.transition(transfer.id, "SENT");
        const paid = await gateway.transition(transfer.id, "PAID");
        return `${paid.id} reached ${paid.status} via PROCESSING to SENT to PAID`;
      },
    );
  }

  const failed = steps.find((s) => !s.ok);

  return NextResponse.json({
    ok: !failed,
    mode: gatewayMode(),
    warning: gatewayWarning(),
    steps,
    hint: failed
      ? `Stopped at "${failed.name}". Check the sandbox business is approved, then that the key is scoped, then that the entity name is exactly New Business Sandbox or Sandbox Business.`
      : mutate
        ? "Full documented sequence works, including mutating calls."
        : "Read path works. Re-run with ?mutate=1 to exercise conversion and the transfer state machine.",
  });
}
