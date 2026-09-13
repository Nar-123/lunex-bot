/**
 * PHASE 5 — LIVE VALIDATION HARNESS (read-only / quote-only).
 *
 *   node dist/validate-live.js rpc --i-understand-this-is-live-validation
 *   node dist/validate-live.js quote TOKEN_ADDRESS AMOUNT_IN_RAW --i-understand-this-is-live-validation
 *
 * Both subcommands are gated behind the SAME explicit
 * `--i-understand-this-is-live-validation` flag: without it the process
 * prints a refusal and exits non-zero. This is the CLI equivalent of a
 * key switch — "run with the values in my .env, against real external
 * services" must never happen because someone typo'd a script name.
 *
 *   rpc    (validate-live-rpc.ts)  Read-only RPC checks against the
 *          configured Robinhood Chain endpoint: latest block, chain id,
 *          executor balances, the StateView/PoolManager binding
 *          self-check, PoolManager event logs, PositionManager code,
 *          receipt lookup, and the NFT ownerOf path — every read the live
 *          cycles' first tick will perform, exercised BEFORE any position
 *          exists. Never sends a transaction.
 *
 *   quote  (validate-live-quote.ts) Fetches REAL quotes from the real
 *          Trading API for a TOKEN -> USDG swap, once per slippage tier
 *          (100/200/300 bps, EXITS.SLIPPAGE_TIERS_BPS), printing input,
 *          output, the API's own priceImpact and minimumAmount, the
 *          requested tolerance, and the approval spender — plus a
 *          fail-closed check of the configured router via the exit flow's
 *          own validateSwapQuote. Never signs, never broadcasts, never
 *          calls /v1/swap.
 *
 * ## Why this file is structurally incapable of broadcasting
 *
 * It imports NO signing/broadcast module — not lazily, not at all. The
 * executor ADDRESS is derived (pure math on the configured private key)
 * only inside the runner modules, so balances can be read; the wallet
 * CLIENT (`blockchain/walletClient.ts`'s signing half) and `execution/`'s
 * pipeline are never constructed here, and the only Trading API methods
 * used are /quote and /check_approval.
 *
 * ## Why the flag check precedes every import
 *
 * `src/config/env.ts` validates the environment at MODULE LOAD and
 * throws on a bad `.env`. If `config` were imported eagerly, a user who
 * runs this without the flag would get a confusing env-validation stack
 * trace instead of the refusal — so the flag is checked BEFORE any
 * config-reading module is imported (deferred dynamic imports below).
 */
const LIVE_FLAG = '--i-understand-this-is-live-validation';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const hasLiveFlag = args.includes(LIVE_FLAG);

  if (!hasLiveFlag) {
    console.error('REFUSED: live validation requires the explicit flag:');
    console.error(`  node dist/validate-live.js <rpc|quote> [args...] ${LIVE_FLAG}`);
    console.error('');
    console.error('This harness talks to REAL external services using the values in your .env.');
    console.error('It never signs or broadcasts anything, but it must still be a deliberate act.');
    process.exit(2);
  }

  // Only PAST the flag do we import anything that reads `config` (and thus
  // the environment) — see the header's deferred-imports note.
  if (subcommand === 'rpc') {
    const { runRpcValidation } = await import('./validate-live-rpc');
    process.exit(await runRpcValidation());
  }

  if (subcommand === 'quote') {
    const tokenAddress = args[1];
    const amountRaw = args[2];
    if (!tokenAddress || !amountRaw) {
      console.error('usage: node dist/validate-live.js quote TOKEN_ADDRESS AMOUNT_IN_RAW ' + LIVE_FLAG);
      console.error('  AMOUNT_IN_RAW is the raw (base-unit) amount of TOKEN to quote, e.g. 1000000000000000000 = 1 token at 18 decimals.');
      process.exit(2);
    }
    let amountInRaw: bigint;
    try {
      amountInRaw = BigInt(amountRaw);
    } catch {
      console.error(`AMOUNT_IN_RAW is not a valid integer: ${amountRaw}`);
      process.exit(2);
    }
    if (amountInRaw <= 0n) {
      console.error('AMOUNT_IN_RAW must be > 0.');
      process.exit(2);
    }
    const { runQuoteValidation } = await import('./validate-live-quote');
    process.exit(await runQuoteValidation(tokenAddress, amountInRaw));
  }

  console.error(`Unknown subcommand: ${subcommand ?? '(none)'}`);
  console.error('usage:');
  console.error(`  node dist/validate-live.js rpc    ${LIVE_FLAG}`);
  console.error(`  node dist/validate-live.js quote TOKEN_ADDRESS AMOUNT_IN_RAW ${LIVE_FLAG}`);
  process.exit(2);
}

void main();
