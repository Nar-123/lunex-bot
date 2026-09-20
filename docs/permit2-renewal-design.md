# Permit2 grant renewal

**Status: implemented as an OPERATOR-ONLY action, never automatic.** A renewal
happens only when a human sends `POST /control/permit2/renew` with the exact
confirmation string. Nothing schedules it, no cycle calls it, and the AI
supervisor cannot reach it.

The *entry* pre-flight (`positions/permit2Preflight.ts`) and the Permit2 readers
(`blockchain/permit2.ts`) remain strictly read-only — they still contain no
transaction construction at all, which `tests/positions/permit2ExpiryAudit.test.ts`
enforces by scanning their source. All write-side code lives in separate modules:

| Module | Role |
|---|---|
| `positions/permit2Renewal.ts` | pure policy: assessment, bounds, calldata, verification |
| `positions/permit2RenewalTx.ts` | live reads + `TxSafetyDeps` for the existing executor |
| `positions/permit2RenewalAction.ts` | the operator action and its idempotency |
| `api/routes/permit2Renew.ts` | `GET` readiness (read-only) and `POST` renewal |

## Why a renewal is needed at all

Uniswap v4 settles a mint through Permit2, not through an ERC20 allowance to the
PositionManager (verified on the first live mint: PositionManager → Permit2 →
`USDG.transferFrom` → PoolManager). Two independent authorizations are required:

| # | Authorization | Who can create it | Expires? |
|---|---|---|---|
| 1 | `USDG.allowance(wallet, Permit2)` | the bot's own approve leg (`positions/approveTx.ts`) | no |
| 2 | Permit2 grant `allowance(wallet, USDG, PositionManager)` → `(amount, expiration, nonce)` | **nobody in the bot today** | **yes** |

Production's grant is `amount = uint160 max`, `expiration ≈ 2026-10-01 16:25
UTC`. When it lapses, every v4 entry is refused by the pre-flight before any
capital is reserved — safe, but entries stop.

## How the grant is created

`Permit2.approve(token, spender, amount, expiration)` — an ordinary on-chain
transaction sent **by the owner wallet itself**, which writes
`allowance[owner][token][spender] = (amount, expiration, nonce unchanged)`.

- **Does it need `Permit2.approve`?** Yes for the on-chain path, and that is the
  path this project should use.
- **Does it need an EIP-712 signature?** **No.** `permit()` (the signature path)
  exists, but this project deliberately has no EIP-712 signing capability — that
  is exactly why the Trading API integration sends `x-permit2-disabled`.
  Introducing signing for renewal would add the capability the whole exit design
  avoids. Use `approve`, not `permit`.
- **Spender:** the **PositionManager** (`config.uniswap.v4.positionManager`), and
  only after `PositionManager.permit2()` confirms it is bound to the configured
  Permit2. Never a spender taken from an API response.
- **Nonce:** `Permit2.approve` does **not** consume or require the nonce — the
  nonce in the tuple is for the signature (`permit`) path and for
  `invalidateNonces`. A renewal by `approve` leaves it alone; the pre-flight
  records it only as evidence.

## Expiration policy

`expiration` is a `uint48` unix second. Options, in order of preference:

1. **Fixed bounded window** (recommended): `chainTime + RENEWAL_WINDOW_SECONDS`,
   e.g. 90 days, from a configured constant with a documented rationale — long
   enough that renewal is rare, short enough that an abandoned key's
   authorization dies on its own.
2. **`type(uint48).max`** (never expires): rejected. It removes the only
   time-bound on a standing authorization to move USDG.

Always compute from **chain time** (`readChainTimestamp`), never the local clock.

## Who authorizes it

An operator, explicitly — the same model as `settle-dust` and `settle-token`:
admin JWT plus an operator-identity check plus an explicit confirmation field.
A renewal moves no funds, but it re-opens a standing permission to move USDG, so
it must never be automatic, never scheduled, and never triggered by the AI
supervisor (whose entire surface is the entry-pause flag).

## How the bot would detect success

Never from the transaction receipt alone. Re-read the grant and require
`amount >= required`, `expiration >= chainTime + minRemainingValidity`, and the
`(owner, token, spender)` tuple to match — i.e. re-run `runPermit2Preflight`
and require `VALID`. That is the same verify-by-independent-read rule every
critical transaction in this repo already follows.

## Implementation sketch (if approved later)

- `src/positions/permit2RenewalTx.ts` building `TxTsafetyDeps` for
  `executeCriticalTransaction`: `buildTransaction` encodes
  `approve(token, spender, amount, expiration)` to the **configured** Permit2,
  `simulate`/`estimateGas`/`signTx`/`broadcast` reuse `viemTxSteps`, and
  `verifyOnChain` re-reads the grant and returns `VALID` or fails.
- Idempotency key like `permit2:renew:<token>:<spender>:<expiration>` so a
  crash/retry resumes rather than sending a second approve.
- `POST /permit2/renew` with `{ spender, amount, expirationSeconds, confirm }`,
  admin-only, refusing any spender or Permit2 address not in the audited
  configuration.
- Gas is trivial (~50k), but the affordability check still applies.

## How renewal would be tested safely

1. Pure unit tests of the calldata builder: exact selector, the configured
   Permit2 as target, the configured token/spender, the computed expiration,
   `value = 0`.
2. Policy tests: refuse an unapproved spender, an unapproved Permit2, an
   expiration in the past, an expiration beyond the configured maximum window.
3. Verify-by-read tests: a receipt that succeeded but left the grant short or
   short-dated must still fail verification.
4. Idempotency/resume tests through `executeCriticalTransaction`'s existing
   fakes (no chain).
5. Real-SQLite integration for the attempt lifecycle.
6. Mutation tests: invert the expiry comparison, drop the spender check, accept
   an unverified read, skip the re-read verification.
7. **No test ever sends a real transaction.** A live rehearsal, if wanted, is an
   operator action on a throwaway key, never in CI.

## Entry behaviour is unchanged

The entry pre-flight still blocks entries the moment the grant is within 30
minutes of expiry, still warns from 7 days out via
`permit2_grant_expiring_soon`, still judges on chain time, and still never
repairs anything. Renewal is a separate, deliberate operator action.

## Renewal windows

| Window | Constant | Meaning |
|---|---|---|
| > 30 days left | — | `VALID_CURRENT`; a renewal is refused and no transaction is built |
| <= 30 days left | `ELIGIBLE_WHEN_REMAINING_SECONDS` | `RENEWAL_NEEDED`; an operator *may* renew |
| <= 7 days left | `RECOMMEND_WHEN_REMAINING_SECONDS` | `renewalRecommended: true`; an operator *should* renew |
| lifetime granted | `DEFAULT_LIFETIME_SECONDS` (90 days) | bounded by `MAX_LIFETIME_SECONDS` (180 days) |

Production's grant expires **2026-10-01 16:25 UTC**. As of 2026-09-20 it is
already inside the eligibility window (~11 days remaining) and becomes
*recommended* on 2026-09-24.
