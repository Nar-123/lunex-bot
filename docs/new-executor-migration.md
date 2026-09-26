# New dedicated executor — migration checklist

The current executor wallet is a pre-existing EIP-7702 consumer smart account:
its delegation and its unlimited third-party allowances predate Lunex by ~2
months, and 8 of its transactions during Lunex's life were external activity
(wallet audit, 2026-09-26). Lunex should run on a plain EOA it alone uses.

Nothing here is a code requirement — the code works on a plain EOA as shipped
(no EIP-7702, ERC-4337, ERC-7579, `authorizationList` or delegated code
anywhere, and the executor identity derives solely from `PRIVATE_KEY`). This
file is the operational sequence, and it is **design only** until each step is
separately approved.

## Required configuration for the new executor

| key | required value | why |
|---|---|---|
| `PRIVATE_KEY` | the new EOA's key | identity follows the key; there is no `EXECUTOR_ADDRESS` |
| `EXIT_MIN_RECEIVED_PROTECTION_ENABLED` | **`true`** | **mandatory.** With the shipped default `false`, D8 FIX 4's aggregate `amountOutMin` bound is dormant: the legs' minimums are never summed against the locally computed floor (only the per-leg "not zero" check applies). Production ran with it `false`; the new executor must not. See `tests/config/minReceivedProtection.test.ts` |
| `EXIT_IMPACT_CHECK_ENABLED` | `true` (already the default) | price-impact gate |
| everything else | unchanged from the current deployment | |

The flag is read from env only (never hardcoded), parses strictly (`"true"` /
`"false"`, anything else is rejected), and turning it off never removes the
per-leg unbounded-leg refusal.

## Permissions the new wallet actually needs

Entry (verified against `positions/permit2Preflight.ts`'s documented settle path):

1. `USDG.approve(Permit2, exact entry amount)` — **created by Lunex itself**
   (`positions/approveTx.ts`, spender fixed to the configured Permit2).
2. Permit2 grant `USDG -> PositionManager` — operator-triggered via
   `POST /control/permit2/renew`; hard-wired to USDG/PositionManager, the
   operator may only choose the lifetime. Works from a zero grant
   (`assessPermit2Renewal` keys eligibility off remaining expiry).

Exit:

3. Ownership of the position NFT — no approval needed to burn.
4. `TOKEN.approve(Permit2, exact receipt amount)` — **created by Lunex itself**
   since the HIGH-1 fix: the on-chain allowance is the source of truth, so the
   leg runs whenever `allowance(TOKEN, wallet, Permit2) < receipt amount`, no
   matter what the Trading API's advisory `needsApproval` says. Tokens differ on
   this chain: MEME hardcodes an infinite Permit2 allowance for every owner, so
   it never needs one; PONS starts at 0 and needs one per exit. Both are handled
   without any manual pre-approval.
5. Permit2 grant `TOKEN -> UniversalRouter` (exact amount, 24 h) — created by
   Lunex's grant leg.

Never needed: an ERC20 approval to the PositionManager, to a Universal Router,
or to any SwapProxy; EIP-712 signing; smart-account features.

## Staged sequence

| stage | action | gate to pass |
|---|---|---|
| 0 | leave the current wallet untouched | production fingerprint recorded |
| 1 | generate the new EOA offline | `eth_getCode` = `0x`, nonce 0 |
| 2 | install `PRIVATE_KEY` + `EXIT_MIN_RECEIVED_PROTECTION_ENABLED=true` in `.env` (mode 600, `lunex-bot:lunex-bot`), restart | service active, `.env` hash changed exactly once, key never logged |
| 3 | verify chain identity | `chainId` 4663, `execution_targets_verified` |
| 4 | verify wallet identity | logged executor address matches, code still `0x` |
| 5 | fund | ~0.01 ETH for gas (measured: a full entry+exit cycle is ~0.9–1.2M gas) + the intended test USDG only |
| 6 | approvals | 6a automatic at first entry; 6b via the renewal endpoint; 4 and 5 above are automatic |
| 7 | read-only probe | quote + `buildSwapTx` validate unsigned, router = the approved one, protocols V2/V3, no V4 |
| 8 | tiny live entry | position size is 35% of free balance, so fund ~3 USDG for a ~1 USDG position (or set `CANARY_MAX_USDG`) |
| 9 | verify exit end to end | remove-liquidity → TOKEN approval → Permit2 grant → swap, all VERIFIED; `realizedUsdgRaw` recorded |
| 10 | restore intended sizing | caps confirmed (35%, 3 positions) |

Abort on: code at the new address, an identity mismatch, a failed target
verification, any approval landing with an unexpected spender or amount, a
refused read-only probe, or unexpected production drift.

## Old wallet cleanup (after stage 9, and only then)

1. Remove the EIP-7702 delegation (type-4 authorization to the zero address) —
   **first**, because while it stands one signed batch can re-grant everything.
2. Revoke the unlimited allowances (PONS, MEME, USDG, OPPAI → `0x294df973…`,
   `0x114d5742…`, `0xcea7608f…`, `0x73991a25…`, Permit2).
3. Lapse the Permit2 grants, leaving USDG → PositionManager until the new
   wallet's own grant is verified.
4. Sweep the PONS/MEME dust (or sell it); the OPPAI remainder is economically
   zero; leave the 140 position NFTs with the old wallet — Lunex's CLOSED rows
   are terminal and fenced.
