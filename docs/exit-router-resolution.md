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

- **Calldata is decoded and checked** (`swap/universalRouterCalldata.ts`): the
  selector, a tight command allowlist, no `PERMIT2_PERMIT`/`PERMIT2_PERMIT_BATCH`,
  a future deadline, and — for V2/V3 — amount, token, recipient, `payerIsUser`,
  and a non-zero `amountOutMin`.
- **The grant is separate from the entry grant** (`exits/permit2TokenGrant.ts`):
  the spender must be an allowlisted Universal Router; USDG and the
  PositionManager are refused outright. Amount is exact, lifetime 24h (max 7d).
- **Strict ordering**: pre-flight → grant (only if needed) → VERIFIED →
  simulate → swap. A grant that does not reach VERIFIED never lets a swap be
  built, and a failed simulation stops the swap before anything is signed.
- **Idempotency** keys on the grant being *replaced* (`…:from<currentExpiration>`),
  so restarts and concurrent exits reuse one attempt, while a grant that expired
  again later gets a new one.

## Not changed

The allowlist; the operator-only USDG → PositionManager grant; entry; D3/D4
behaviour; gas policy and the executor pipeline.
