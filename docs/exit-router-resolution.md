# Exit-router resolution (2026-09-20 / 21)

Every TOKEN exit leg was blocked. This records why, what changed, and what the
evidence was — so the change can be reviewed without re-deriving it.

## The block

With `x-permit2-disabled: true`, the Trading API's `/v1/swap` targets a
SwapProxy. On chain 4663 it maps that to `0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9`,
which is **not** on the allowlist. Lunex refused it, so no exit could sell its
TOKEN side (both PONS and MEME ended in dust settlement).

Reproduced across every documented header and body option — 10+ variants, 5+
independent calls, two tokens. No client-side option yields the approved proxy.

Worth knowing: the legacy and approved proxies have **byte-identical** runtime
bytecode, and the legacy-proxy transaction simulates successfully. The block was
the allowlist working as designed, not a broken transaction.

## The change

The exit client no longer sends `x-permit2-disabled`, and pins
`x-universal-router-version: 2.1.1`. The API then targets the **approved**
Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904` directly — an
address that was already allowlisted, so nothing new is trusted.

### Why the version pin is not optional

Without it the API picks its own default router, and that default moved:

| When | Default target (Permit2-enabled, no version header) |
|---|---|
| 2026-09-20 15:04Z | `0x8876…0904` — approved |
| 2026-09-21 04:41Z | `0x204FAca1764B154221e35c0d20aBb3c525710498` — **not** approved |

`0x204F…` is a different Universal Router build (24,380 vs 24,546 bytes of
runtime code) bound to the same PoolManager. Pinning `2.1.1` returned `0x8876…`
again. The API accepts exactly `[2.0, 2.1.1]`; `2.0` has no route for these pairs.

The allowlist remains the authority: if `2.1.1` were ever mapped elsewhere, the
swap is refused exactly as before.

## How the router gets the TOKEN — no EIP-712

The returned calldata is `execute(commands, inputs, deadline)` with a single
`V3_SWAP_EXACT_IN` and `payerIsUser = true`. It contains **no** `PERMIT2_PERMIT`
command: the router pulls the token through an existing on-chain Permit2
**allowance**, not a signature. `permitData` in the quote is an offer of the
signature route, which this project does not use.

Proven with read-only `eth_call` + state override (Permit2 allowance base slot 1,
located by matching the known USDG → PositionManager grant):

- without a Permit2 grant `(wallet, TOKEN, 0x8876…)` → **reverts**
- with that grant injected → **succeeds**

So each exit creates that grant first, with an ordinary `Permit2.approve`
transaction — the same contract and function the operator-only renewal uses,
with different arguments.

## Guarantees

- **Calldata is decoded and every command checked** (`swap/universalRouterCalldata.ts`).
  Only `V2_SWAP_EXACT_IN` and `V3_SWAP_EXACT_IN` are accepted. For **every** leg:
  input token = the position TOKEN (a malformed path is refused, never skipped),
  amount > 0, recipient = the executor wallet, `payerIsUser = true`, and
  `amountOutMin > 0`. The legs' amounts must sum to **exactly** the requested
  amount. One future deadline per batch; strict command/input count.
- **Refused outright:** `V4_SWAP`, `PERMIT2_PERMIT`, `PERMIT2_PERMIT_BATCH`,
  `SWEEP`, `PAY_PORTION`, exact-output swaps, and any command not listed above.
- **The grant is separate from the entry grant** (`exits/permit2TokenGrant.ts`):
  the spender must be an allowlisted Universal Router; USDG and the
  PositionManager are refused outright. Amount is exact, lifetime 24h (max 7d).
- **Strict ordering**: pre-flight -> grant (only if needed) -> VERIFIED -> swap.
  A grant that does not reach VERIFIED never lets a swap be built.
- **Simulation is the executor's**: `executeCriticalTransaction` builds once,
  persists that exact `txRequest`, simulates the persisted object and signs only
  if it passed -- the simulated bytes are the signed bytes.
- **Idempotency** keys on the grant being *replaced* (`...:from<currentExpiration>`),
  so restarts and concurrent exits reuse one attempt, while a grant that expired
  again later gets a new one.

## D7 corrections (pre-D6 audit of 7aa6f35)

Two blockers, both fixed and regression-tested:

1. **V4 was accepted unvalidated.** `V4_SWAP` returned early without decoding
   its nested V4Router actions -- a garbage payload passed. With V4 allowed, the
   live API routed **both** PONS and MEME through `V4_SWAP`. Now V4 is refused,
   and the client requests `protocols: ["V2","V3"]`; both tokens still route.
   V4 needs a complete, tested decoder before it can be allowed. A partial
   decoder is not an acceptable intermediate step.
2. **Only the first swap leg was checked** (`findIndex`). A valid first leg plus
   an attacker-paid second leg with `amountOutMin = 0` passed; a legitimate
   split was wrongly refused. Now every leg is checked and the amounts summed.

Also removed: a separate pre-send `eth_call` added in 7aa6f35. It called
`buildTransaction` a second time -- a second `/v1/swap` request -- so it
simulated **different** calldata from what was signed. The executor's
persisted-tx simulation already covers the signed bytes.

## D8 corrections (exit-safety review of 0525c41)

Four fixes, all regression-tested and mutation-tested:

1. **An exit sold the WALLET-WIDE TOKEN balance.** `amountInRaw` fell back to
   `readTokenBalance(...)`, so TOKEN belonging to another position (or arriving
   from anywhere else) could be sold under this close -- and granted to the
   router through Permit2. The amount is now always the remove-liquidity
   receipt's own `tokenProceedsRaw`; a legacy attempt that recorded none has its
   receipt re-read. The wallet balance is only a floor check: below the receipt
   amount the exit defers (PENDING, stays CLOSING) rather than selling a
   different amount. The grant and the quote use that same receipt amount.
2. **A definitively failed Permit2 grant could never be retried.** The key was
   derived from the on-chain expiration it replaced, which a failed approval
   leaves unchanged, so every later tick re-read the same cached FAILED row and
   the exit's swap leg was blocked for good. The key now carries a retry
   generation (`:r<n>`) derived from the grant attempts already persisted for
   that prefix, so it advances ONLY past a definitive failure -- never for a
   crash, an ambiguous broadcast, SIGNED/SENT/CONFIRMED, a restart or a
   concurrent worker, all of which still resolve to the same key. No schema
   change: the generation is read from existing `TransactionAttempt` rows. Past
   32 generations the exit defers for an operator.
3. **Every leg must END at the configured USDG.** Only the input token was
   checked, so a leg selling the right TOKEN into the wrong asset passed. Both
   path endpoints are now decoded (V2 needs >= 2 hops; V3's last 20 bytes), and
   the destination is compared against `config.quoteAsset.ADDRESS`.
4. **`amountOutMin` is bound to our own computed minimum.** `> 0` alone let a
   1-wei minimum satisfy any policy. The legs' minimums must now SUM to at least
   the minimum this project derives from the quote and its slippage tier (not
   the API's echoed minimum). Per-leg proportional floors are deliberately not
   asserted -- a split's legs price differently and only the aggregate is
   quoted, while the aggregate already bounds every leg.

## Not changed

The allowlist; the operator-only USDG → PositionManager grant; entry; D3/D4
behaviour; gas policy and the executor pipeline.
