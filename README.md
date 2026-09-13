# Lunex Bot

Automated single-sided USDG concentrated-liquidity provider bot for
**Robinhood Chain** (EVM-compatible L2), trading against Uniswap v2/v3/v4
and UniswapX. Manages real funds — correctness and safety take priority
over development speed.

Architecture: one backend API is the single source of truth for all bot
state (positions, config, logs). The Telegram bot and Web UI are separate
clients that both talk to this API — neither holds its own state.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — never commit .env
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

## Project structure

```
src/
  config/       typed, spec-locked configuration (this module)
  discovery/    GMGN candidate discovery
  filters/      hard-filter token screening
  pools/        pool selection + fee tier logic
  strategies/   LP range calculation
  capital/      position sizing, exposure caps
  positions/    active position state
  monitoring/   real-time position tracking
  exits/        exit trigger logic
  execution/    transaction safety flow (build -> simulate -> send -> verify)
  swap/         exit-to-USDG swap execution
  cooldown/     per-token cooldown tracking
  blockchain/   chain clients, contract bindings, ABIs
  storage/      persistence (Prisma-backed repositories)
  composition/  the live app: three scheduled cycles, real dependency wiring, structured logging
  index.ts      thin process entrypoint (construct deps, start, wire SIGTERM/SIGINT) -- `npm start` runs this
  telegram/     Telegram bot client (control + on-demand reporting only)
  api/          backend HTTP API (single source of truth)
  auth/         username/password auth, sessions, rate limiting
ui/             Web UI (full control: positions, params, pause/resume, logs)
tests/          unit/integration tests
prisma/         Prisma schema + migrations
```

## Module status

Renumbered from the original plan to match how modules have actually been
requested/delivered (`pools/` and `strategies/` turned out to be two
separate passes, not one):

- [x] Module 1 — Project scaffold + config
- [x] Module 2 — discovery/ + filters/ (+ unit tests)
- [x] Module 3 — pools/ (pool selection, v4-only) + blockchain/ prep
- [x] Module 4 — strategies/ (LP range calculation)
- [x] Module 5 — capital/ + cooldown/ (+ storage/, first real Prisma use)
- [x] Module 6 — execution/ + blockchain/ (transaction safety flow)
- [x] Module 7 — positions/ + monitoring/
- [x] Module 8 — exits/ + swap/
- [x] Module 9A — positions/openPosition.ts
- [x] Module 9B — composition root (bot is a real running process: three live cycles wired end-to-end)
- [x] Module 10 — api/ + auth/
- [x] Module 11 — telegram/ (Lunex's own on-demand control/reporting bot)
- [x] Module 12 — ui/
- [x] Tier 3 — Meridian exit-ladder alignment (Safety Exit, Over-extended %B, Trailing TP, OOR profit; LOW_YIELD disabled pending pool-level data)
- [x] Validation phase — LOW_YIELD metric resolution, realized-PnL persistence, read-only live-validation harnesses (Phase 5)
- [x] P1 fix — proceeds-read failure after a confirmed exit leg is resumable (see "P1 fix" at the end of this file)
- [ ] Live validation with a real fill (tiny, separately approved) — not done; see LIVE VALIDATION CHECKLIST
- [ ] LOW_YIELD re-enable — requires a real pool-level fee/TVL 24h feed first
- [x] ops/lunex-ai/ — Lunex AI development supervisor (Telegram-controlled, never trades): code, tests and build done; VPS deployment is an operator step, see [ops/lunex-ai/DEPLOYMENT.md](ops/lunex-ai/DEPLOYMENT.md)

## Module 1 — assumptions & decisions

These are called out explicitly so they can be corrected before they
propagate into later modules.

1. **Package manager / runtime**: npm, Node.js >= 20, CommonJS output
   (`tsconfig.json` targets ES2022/CommonJS — simplest interop with the
   current Telegraf/Express/Prisma ecosystem; can move to ESM later if
   needed, but that's a mechanical change, not a design one).

2. **Blockchain libraries — ethers v5 + viem, not ethers v6.**
   **Superseded — see "Revision 1" below** for the corrected rationale
   (originally this doc chose ethers v6 only; that's been reverted after
   review against verified production code). Robinhood Chain is still
   treated purely as a `chainId` + `rpcUrl` pair (`config.chain`) with no
   chain-specific SDK — any EVM JSON-RPC endpoint works. `RPC_FALLBACK_URLS`
   is already in config (comma-separated) so `blockchain/` can implement
   provider failover for the Safety Exit trigger without a config change.

3. **Uniswap surface**: `@uniswap/sdk-core`, `@uniswap/v3-sdk`,
   `@uniswap/v4-sdk`, and `@uniswap/uniswapx-sdk` are all included as
   dependencies now, even though only `pools/`/`strategies/`/`execution/`
   will actually exercise them. The spec's LP strategy (single-sided,
   concentrated, tick-bounded) is fundamentally a v3-style concentrated
   position; whether a given TOKEN/USDG pool is actually deployed on v2,
   v3, or v4 is a per-pool fact resolved in `pools/` (Module 3) — the
   fee-tier/version selection logic isn't guessed here in config.

4. **Storage — Prisma ORM**, provider-switchable between SQLite
   (development / single-instance default) and Postgres (recommended for
   production) via `DATABASE_PROVIDER` + `DATABASE_URL`. Prisma was chosen
   over hand-rolled SQL or a manual dual-repository implementation because:
   it gives one schema/migration path for both engines, real transactions
   (needed for crash-safe state updates per the Transaction Safety spec),
   and generated types. All DB access will go through `storage/` repository
   interfaces — no other module talks to Prisma directly — so the
   SQLite/Postgres choice stays a one-line config change. `prisma/schema.prisma`
   currently has no models; they're added incrementally as each module
   (cooldown, capital, positions, tx-safety log) actually needs persisted
   state, per the instruction not to build everything in one pass.

5. **Config module shape**: `src/config/env.ts` validates all environment
   variables once via `zod` at process start and throws immediately on any
   missing/invalid required value (fail fast — this bot moves real money).
   `src/config/constants.ts` holds every spec-locked numeric/business
   parameter, grouped by the same numbered sections as the functional spec,
   so a reviewer can diff spec vs. code section-by-section. `src/config/index.ts`
   composes both into a single typed `config` object (`as const`) that every
   other module imports — no other file should define its own copy of a
   number like `0.35` or `-0.15`.

6. **Explicitly-unlocked parameters are not guessed.** Per spec, the ETH
   gas reserve mechanism is undecided:
   `config.rules.capital.ETH_GAS_RESERVE_ENABLED` defaults to `false` and
   `ETH_GAS_RESERVE_MIN` defaults to `0`, both sourced from env
   (`ETH_GAS_RESERVE_ENABLED` / `ETH_GAS_RESERVE_MIN`), so `capital/`
   (Module 4) can read a single flag + value and enforce a reserve later
   without restructuring position-sizing logic. The same pattern is used
   for the two "OFF by default, must stay easy to re-enable" exit safety
   toggles: `config.rules.exits.IMPACT_CHECK_ENABLED` and
   `config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED`. `exits/`/`swap/`
   (Module 7) must still **compute and log** price impact on every exit
   swap regardless of the flag — only the *blocking* behavior is gated.

7. **Auth baseline**: env already carries a bcrypt password *hash*
   (`AUTH_ADMIN_PASSWORD_HASH`) rather than a plaintext password, plus a
   `JWT_SECRET`/expiry pair and login rate-limit settings, matching the
   spec's baseline security requirement (rate limiting on login, HTTPS,
   session/token expiry) ahead of the `auth/`/`api/` module (Module 8).
   No IP allowlist exists anywhere in config, matching "all IPs allowed."

8. **Telegram config** only stores a bot token, display name (default
   `Lunex Bot`), and an authorized-user-id allowlist for *command*
   authorization — there is no notification-related config at all, since
   push notifications are explicitly out of scope for every event
   including critical ones.

9. **Testing** will use `vitest` (fast TS-native runner, no ts-jest
   transpile step) starting in Module 2 with the first filter unit tests.

## Module 2 — assumptions & decisions

1. **`CandidateToken` is the boundary type.** `discovery/` is the only
   module that knows about GMGN's raw response shape. Everything else
   (filters, and later pools/strategies/capital) consumes the normalized
   `CandidateToken` from `src/discovery/types.ts`. If GMGN's real schema
   turns out different from the assumption below, only `discovery/`
   changes.

2. **GMGN integration — superseded, see "Revision 1" below.** Originally
   implemented as a best-effort direct HTTP call with guessed field names;
   corrected to a `gmgn-cli` child-process integration with verified field
   names after review. Still isolated behind the `GmgnClient` interface
   (`gmgnClient.ts`) so nothing in `filters/`, `pools/`, etc. depends on
   GMGN's raw shape.

3. **Validation fails loudly, never guesses.** `gmgnMapper.ts` uses a
   strict zod schema with no optional/defaulted financial fields. A
   malformed or unexpected GMGN response throws `GmgnMappingError`
   immediately rather than silently treating a missing market cap or fee
   as `0` — a wrong silent default here could wrongly pass or reject a
   real deployment decision. An unrecognized `asset_type` string
   normalizes to `'Unknown'`, which is on the **rejected** list — an
   unrecognized category is refused by default, not accidentally allowed.

4. **Duplicate-position and cooldown checks are dependency-inverted.**
   Per the build order, `cooldown/` (Module 4) and `positions/` (Module 6)
   don't exist yet, but two of the eight hard filters need them ("token
   already has an active position", "token is in its 2h post-exit
   cooldown"). `filters/types.ts` defines two small ports —
   `ActivePositionChecker` and `CooldownChecker` — and `screenCandidate()`
   takes them as injected `deps`, never importing a concrete
   implementation. Both are keyed by contract address (not symbol) — see
   "Revision 1" below for the cooldown interface's remaining-time update.

5. **All 8 checks always run, never short-circuit.** `screenCandidate()`
   evaluates every rule (in the same order as the spec's table) even
   after an earlier one fails, so a rejected candidate's full breakdown
   (which rules passed/failed and why) is available for logs and the
   future Web UI/Telegram reports. `passed` is true only if all 8 pass;
   `failedRule` records the *first* failure in spec-table order for a
   quick one-line reason.

6. **Boundary conditions follow the spec's exact wording**, verified by
   unit tests: market cap `>=` $1,000,000 (passes at exactly 1,000,000),
   token age `>=` 1 day, volume strictly `>` 0, total fee `>=` 0.5 ETH,
   holder concentration strictly `<` 40% (fails at exactly 40%).

7. **Discovery scheduling** (`discovery/scheduler.ts`) is a minimal
   interval runner with a re-entrancy guard — if one discovery/screening
   cycle is still running when the next 30-minute tick fires, that tick
   is skipped rather than queued or overlapped, since two cycles must
   never race against the same capital/position state. It isn't wired to
   `index.ts` yet — that happens once `capital/`, `cooldown/`, and
   `execution/` exist to actually act on a passing candidate.

8. **Testing** (counts as of Revision 1, see below): 71 unit tests across
   14 files, covering every filter rule (pass/fail + boundary cases), the
   screening orchestrator (ordering, full-evaluation, dependency-injected
   checks), and the GMGN response mapper/CLI client (valid parse,
   schema-violation rejection, asset-type normalization, CLI argument
   allowlisting, partial-failure handling). `tsconfig.json` type-checks
   `src/` + `tests/` together (no `rootDir` restriction); a separate
   `tsconfig.build.json` restricts the production `npm run build` output
   to `src/` only.

See "Revision 1" below for corrections applied after verification against
production code from similar projects — read that before Module 3.

## Revision 1 — corrections after production-code verification

Applied before starting Module 3, based on the user's review against
verified production code (not guesses). All 9 points below are done;
the affected unit tests were rewritten and the full suite (71 tests)
passes.

1. **GMGN `market trending` field names corrected.** `market_cap` (was
   guessed as `market_cap_usd`), `gas_fee` (was guessed as
   `total_fee_eth`) — **`gas_fee` is denominated in the chain's native gas
   currency (ETH on Robinhood Chain), not USD**, called out explicitly in
   code comments in [gmgnMapper.ts](src/discovery/gmgnMapper.ts) so this
   can't be silently re-assumed as USD later. `top_10_holder_rate` was
   already correct (0..1 fraction). The CLI/API filter flag is
   `--min-gas-fee`; a *different* flag, `--min-total-fee`, exists only on
   the unrelated `trenches` endpoint and is not used here — Lunex applies
   its fee threshold client-side in
   [filters/rules/totalFee.ts](src/filters/rules/totalFee.ts) instead, so
   the business threshold lives in exactly one place
   (`config.rules.filters`).

2. **Token age needs a second call.** `market trending` does not return
   age at all. [gmgnCliClient.ts](src/discovery/gmgnCliClient.ts) now
   issues one `token info --address <addr>` call per candidate (up to 10
   per 30-minute cycle, sequential with a 500ms gap, not parallel) to read
   `creation_timestamp` (Unix **seconds** — converted to the internal
   epoch-**milliseconds** `createdAt` in
   [gmgnMapper.ts](src/discovery/gmgnMapper.ts)'s `mergeCreatedAt`). Two
   distinct failure modes are never collapsed into "zero candidates":
   a malformed/unexpected `market trending` response always throws
   `GmgnMappingError` (see `mapTrendingResponseToPartialCandidates`);
   a single candidate's `token info` call failing only excludes *that*
   candidate (logged via a warning) and the cycle continues with the
   rest. A genuinely empty but well-formed `{ data: [] }` response is
   still accepted as "zero candidates today," not an error — tested
   explicitly in
   [gmgnMapper.test.ts](tests/discovery/gmgnMapper.test.ts).
   `scheduler.ts` doesn't do per-call rate limiting itself (that's
   `GmgnCliClient`'s job, since it owns the burst of calls) — its
   re-entrancy guard just ensures one cycle's whole burst can never
   overlap the next cycle's.

3. **Chain-slug mapping centralized.** Added
   `GMGN_CHAIN_SLUGS: Record<chainId, slug>` (`4663 -> "robinhood"`) and
   `getGmgnChainSlug()` in
   [config/constants.ts](src/config/constants.ts:29-45) — every GMGN call
   resolves the slug from there instead of a hardcoded string.

4. **GMGN is now called via `gmgn-cli` (child process), not raw HTTP** —
   `gmgnHttpClient.ts` was replaced with
   [gmgnCliClient.ts](src/discovery/gmgnCliClient.ts). Command-injection
   defense, since token names/symbols are attacker-controlled (anyone can
   mint a token with any name):
   - Every process spawn uses `execFile` (never `exec`/a shell string), so
     shell metacharacters are never interpreted in the first place.
   - [cliExec.ts](src/discovery/cliExec.ts) additionally allowlists every
     argument that reaches argv (EVM address, chain slug, timeframe,
     limit) against a strict regex/range **before** it's used — this
     guards against *argument injection* (a value crafted to be parsed as
     a flag, e.g. `--config=...`, rather than a plain value). Writing this
     test caught a real bug in the first pass: the chain-slug regex
     allowed a leading `-`, so `--flag` would have passed; fixed to
     require an alphanumeric first character.
   - Token name/symbol are **never** passed as a CLI argument at all —
     only sanitized for display. [sanitize.ts](src/discovery/sanitize.ts)
     strips control characters and every Markdown/MarkdownV2/HTML special
     character before a name/symbol ever becomes part of a
     `CandidateToken`, so it can't break Telegram/UI report formatting or
     inject markup later.
   - The API key travels to the child process via `env`, never as a CLI
     argument (argv is visible to other local processes via `ps`/Task
     Manager; env passed this way is not).

5. **ethers v5 (for Uniswap SDK glue) + viem (for everything else),
   ethers v6 dropped.** `package.json` updated
   (`ethers@^5.8.0` + `viem@^2.56.3`, no `ethers@^6`). **Transparency
   note**: while implementing this I inspected the installed
   `@uniswap/v3-sdk`/`v4-sdk` directly — their `Pool`/`Position` math
   entities take plain JSBI/number values, not an ethers-specific type, so
   I didn't find a hard technical blocker that would make ethers v6 fail
   for this SDK surface specifically. I implemented the switch as
   instructed anyway since it's a deliberate, low-risk choice (both
   `@uniswap/v4-sdk` and `@uniswap/uniswapx-sdk` already pull
   `ethers@^5.7.0` transitively regardless, so this removes a
   version split rather than creating one) — flagging the discrepancy
   here in case it changes anything on your end. `blockchain/`'s actual
   viem client (RPC calls, signing, sending transactions) is still built
   in Module 5, per the original plan — this revision only fixed the
   dependency choice.

6. **`createRequire` for `@uniswap/v3-sdk`/`v4-sdk`** — implemented in
   [blockchain/uniswapSdk.ts](src/blockchain/uniswapSdk.ts). Also
   transparent here: this project compiles to CommonJS
   (`tsconfig.json` -> `"module": "commonjs"`, no `"type": "module"` in
   `package.json`), so a plain `import` was already lowering to
   `require()` at build time, and I confirmed both packages ship a clean
   `exports.require` pointing at a concrete file (not a directory) —
   meaning the specific ESM directory-import failure likely doesn't apply
   to this project as currently configured. `createRequire` is applied
   anyway, exactly as instructed, as explicit insurance against a future
   ESM migration or an `exports`-map regression in either package.

7. **Non-standard fee-tier patch prepared, not guessed.** This surfaced a
   real bug: `config/constants.ts`'s `POOL_FEE_TIERS` previously used
   `bps: 3000/4000/5000`, which in Uniswap's actual fee unit (hundredths
   of a bip; `fee / 1_000_000 = fraction`) means 0.3%/0.4%/0.5%, **not**
   3%/4%/5% — fixed to the correct raw values `30000/40000/50000`
   (verified against the installed `@uniswap/v3-sdk`'s `FeeAmount`/
   `TICK_SPACINGS` exports). Confirmed by direct inspection: `TICK_SPACINGS`
   is exported via a getter but returns a plain, extensible object, so
   adding entries for our tiers works, and `Pool`'s constructor only
   asserts `Number.isInteger(fee) && fee < 1_000_000` — a non-standard
   fee value itself is never rejected.
   [blockchain/uniswapSdk.ts](src/blockchain/uniswapSdk.ts) exposes
   `registerV3TickSpacing(fee, tickSpacing)`, verified end-to-end
   (patches, is idempotent, force-overridable, rejects invalid input).
   **Deliberately not pre-filled with guessed tick-spacing numbers**: the
   correct value for each custom tier depends entirely on how Robinhood
   Chain's actual Uniswap v3 factory was configured
   (`feeAmountTickSpacing(fee)`) and must be read from that contract when
   `pools/` (Module 3) resolves a real pool — hardcoding a guessed spacing
   here could silently produce mathematically invalid ticks for real
   positions, which is a fund-safety risk, not a cosmetic one.

8. **Checker interfaces already keyed by contract address** — confirmed,
   no change needed. `ActivePositionChecker.hasActivePosition(tokenAddress)`
   and the cooldown checker below both take the EVM address
   (`CandidateToken.address`), never the symbol.

9. **`CooldownChecker` now returns full remaining-time status**, not just
   a boolean:
   `getCooldownStatus(tokenAddress): Promise<{ inCooldown, remainingMs, cooldownEndsAt? }>`
   (replaces the old `isInCooldown(): Promise<boolean>`), so a future
   Telegram/UI `/status` report can show "cooldown ends in 47m" instead of
   just pass/fail.
   [filters/rules/cooldown.ts](src/filters/rules/cooldown.ts) updated
   accordingly.

**Superseded note on #7 (added in "Revision 2" below):** the v3
`registerV3TickSpacing` patch described above no longer exists — the
architecture change to Uniswap-v4-only pool selection (Revision 2) made
it unnecessary, confirmed by directly inspecting the installed
`@uniswap/v4-sdk`: v4's `Pool` takes `tickSpacing` as an explicit
constructor argument, never derived from `fee` via a lookup table. See
Revision 2, point 14.

## Revision 2 — Module 3 architecture change (pool selection, v4-only)

Section 3 of the original spec ("Pool Selection & Fee Tier", fee tier
selected from 6H volume thresholds: <$50k -> 3%, $50k-$150k -> 4%,
>$150k -> 5%) is **removed entirely, not deprecated** — no code
implements it in any form anymore. It's replaced by a real, on-chain,
Uniswap-v4-only pool selection flow. Points 1-8 from the instruction that
prompted this revision were a re-statement of Revision 1 above (already
applied) — re-verified, no further code changes needed for those; this
section covers what's new (points 9-14).

### The new flow ([pools/selectPool.ts](src/pools/selectPool.ts))

```
GMGN 6H Top 10 -> Token Filter (Module 2, unchanged)
-> discover every TOKEN/USDG Uniswap v4 pool
-> keep only pools with fee > 0 AND estimated exit price impact
   <= PRICE_IMPACT.MAX_EXIT_IMPACT_PCT (1%) -- via a REAL swap
   simulation against the pool's actual liquidity, never a TVL ratio
-> among survivors, pick the highest 6H volume
-> no pools at all, or none survive -> reject the candidate, fall
   through to the next GMGN candidate (existing per-cycle fallback rule)
```

1. **v4-only, confirmed in code, not just in intent.**
   [blockchain/uniswapSdk.ts](src/blockchain/uniswapSdk.ts) now
   `createRequire`s only `@uniswap/v4-sdk`; the old `v3Sdk` export and
   `registerV3TickSpacing`/`isV3TickSpacingRegistered` patch machinery
   are gone. `@uniswap/v3-sdk` was removed from `package.json`'s direct
   dependencies (confirmed still resolvable — it's a real transitive
   dependency of `@uniswap/v4-sdk`, used internally for v4's swap math,
   exactly as expected: "supply chain, not something Lunex calls
   directly"). `config.rules.poolSelection.MIN_FEE = 0` and the fee>0
   filter are the only "fee tier" concept left anywhere.

2. **Exit price impact is a REAL simulation, not a ratio — this was
   verified against the actual installed SDK, not assumed.**
   [pools/priceImpact.ts](src/pools/priceImpact.ts) constructs a real
   `@uniswap/v4-sdk` `Pool` from on-chain state and calls its
   `getOutputAmount()`, which walks the pool's actual tick-liquidity
   distribution using Uniswap's own swap math (confirmed by reading
   `v4-sdk`'s `Pool.js`/`v3Swap.js` source directly) — then compares that
   simulated output against the no-slippage mid-price quote using
   `@uniswap/sdk-core`'s own `computePriceImpact` (the same formula
   Uniswap's frontend uses), rather than hand-rolled math. All 4 unit
   tests in
   [tests/pools/priceImpact.test.ts](tests/pools/priceImpact.test.ts)
   exercise this against the real SDK (not a mock): deep liquidity passes
   with low impact, shallow liquidity correctly fails, and two safety
   edge cases were found and verified empirically while building this:
   - A pool with a swap-affecting hook makes `Pool.getOutputAmount()`
     throw `'Unsupported hook'` (confirmed in the SDK source) — handled
     as `{ ok: false }`, always treated as a rejection.
   - If the caller's fetched tick window is too narrow for the swap to
     fully walk, this does **not** throw or silently under-report — the
     SDK treats any region beyond the supplied ticks as zero liquidity,
     which pushes the computed impact toward 100% (fails, rejects) rather
     than toward 0% (would wrongly pass). Verified empirically, not
     assumed — see the test named accordingly. This means
     `PoolStateProviderPort` only needs to fetch a "reasonably wide"
     window, not a provably complete one — the failure mode is safe by
     construction.

3. **Exit-side simulation, sized to the real position.** The simulated
   direction is TOKEN -> USDG (an exit swap), and the amount simulated is
   whatever `positionSizeUsdgRaw` (passed in by the caller) is worth in
   TOKEN at the pool's current mid price — i.e. "if this whole position
   had to be exited right now, at this pool, how much would that cost."
   `selectPool()` takes `positionSizeUsdgRaw` as a plain parameter rather
   than depending on a `capital/` interface (which doesn't exist yet,
   Module 4) — the caller (eventually `capital/` or the top-level
   orchestrator) is responsible for computing "35% of free USDG,
   right now" and passing the real number in. Per the instruction: this
   means pool pass/fail for the exact same candidate can change between
   cycles as free balance changes — that's intended, not a bug.

4. **One threshold, defined once.**
   [config/constants.ts](src/config/constants.ts) adds
   `PRICE_IMPACT.MAX_EXIT_IMPACT_PCT = 0.01`, used by `selectPool()` here
   and referenced directly (via a comment pointing at the same constant,
   not a duplicated number) in `EXITS.IMPACT_CHECK_ENABLED`'s doc comment
   for when that currently-OFF real-time exit check is re-enabled later.

5. **Pool discovery, state, and volume are all new on-chain integrations
   — flagged the same way GMGN was in Revision 1: best-effort, isolated
   behind a port, needs verification against Robinhood Chain's actual
   deployment before real funds are at risk.**
   - [pools/poolDiscovery.ts](src/pools/poolDiscovery.ts) — v4 has no
     on-chain "list pools for a pair" function (unlike v3's factory), so
     this scans `PoolManager.Initialize` event logs filtered by the
     sorted `currency0`/`currency1` topics, chunked to respect RPC block-
     range limits. The `Initialize`/`Swap` event ABI
     ([blockchain/abis/v4PoolManager.ts](src/blockchain/abis/v4PoolManager.ts))
     is the well-known, stable v4-core shape but unconfirmed against the
     actual Robinhood Chain deployment.
   - [pools/poolStateProvider.ts](src/pools/poolStateProvider.ts) — reads
     slot0/liquidity/ticks via a periphery `StateView` contract
     ([blockchain/abis/v4StateView.ts](src/blockchain/abis/v4StateView.ts),
     also unconfirmed) by scanning a bounded window of tick-bitmap words
     around the current tick — new `UNISWAP_V4_STATE_VIEW_ADDRESS` config
     value needed. The tick-compression bitmap math is unit-tested
     directly ([tests/pools/poolStateProvider.test.ts](tests/pools/poolStateProvider.test.ts))
     and this caught a real off-by-one bug (a stray double-adjustment for
     negative ticks) before it ever touched real data.
   - [pools/poolVolumeProvider.ts](src/pools/poolVolumeProvider.ts) —
     v4 has no built-in volume counter, so 6H volume is computed by
     summing real `Swap` event logs for that specific pool. Flagged as
     the most likely piece to need replacing with a real
     indexer/subgraph-backed implementation in production (same
     interface, `PoolVolumeProviderPort`, so that's a drop-in swap) if
     Robinhood Chain has meaningful swap volume and a rate-limited RPC.
   - New config: `UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK` (lower bound for
     log scans — scanning from block 0 is impractical) and
     `UNISWAP_V4_STATE_VIEW_ADDRESS`, both added to `.env.example`.
   - `blockchain/viemChain.ts` / `viemClient.ts` were added now (pulled
     forward from the original Module 5 plan) because pool selection
     itself genuinely needs read-only on-chain access (log scans,
     contract reads) — this is a read-only `PublicClient` only; signing
     and the full transaction-safety flow are still built in Module 5.

6. **Point 14, answered by direct inspection, not assumption**: confirmed
   in `@uniswap/v4-sdk`'s own source
   (`Pool.js`/`Position.js`) that `tickSpacing` is always an explicit
   constructor/`PoolKey` argument, never looked up from a fee-keyed table
   — no v3-style patch is needed for v4. Documented directly in
   [blockchain/uniswapSdk.ts](src/blockchain/uniswapSdk.ts).

7. **`strategies/` (LP range calculation) is intentionally NOT part of
   this commit.** The instruction's Module 3 scope for this pass was
   specifically "pool selection... GANTI TOTAL Section 4," which is what
   `pools/` now implements; the LP range math (lower/upper tick
   computation from spot price) is unrelated to this architecture change
   and still needs its own pass — flagging this explicitly so it isn't
   assumed done.

8. **Testing**: 89 unit tests across 17 files (up from 71). The 18 new
   ones all exercise real logic against the real `@uniswap/v4-sdk`/
   `@uniswap/sdk-core` math (not mocked) for price impact, plus mocked-
   port tests for the `selectPool` orchestration (fee=0 exclusion never
   even calls the state/volume ports, highest-volume-among-survivors
   selection, mixed-rejection-reason handling) and pure-function tests
   for the tick-bitmap math.

Please review — especially point 5 (the three new on-chain integrations:
event ABI shapes, `StateView` ABI, and the two new contract-address env
vars that need real values) — before `strategies/` or Module 4 starts.

## Revision 3 — confirmed addresses, StateView self-check, exit-swap architecture note

1. **Real Robinhood Chain addresses filled in — no longer blank/TBD.**
   `UNISWAP_V4_POOL_MANAGER_ADDRESS` (`0x8366a39cc670b4001a1121b8f6a443a643e40951`)
   and `UNISWAP_V4_STATE_VIEW_ADDRESS`
   (`0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`) are now the real defaults
   in [config/env.ts](src/config/env.ts) (and documented in
   [.env.example](.env.example)) — both also now format-validated
   (`0x` + 40 hex chars) since they're load-bearing, not optional.
   `UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK` is still `0` (not yet provided)
   — pool discovery/volume log scans will be slow/impractical on a live
   chain until that's filled in.

2. **StateView<->PoolManager self-check added.**
   [pools/poolStateProvider.ts](src/pools/poolStateProvider.ts) now calls
   `StateView.poolManager()` (added to
   [blockchain/abis/v4StateView.ts](src/blockchain/abis/v4StateView.ts))
   and compares it against `config.uniswap.v4.poolManager` before the
   first real state read — a mismatch between the two address env vars
   (copy/paste error, wrong network, etc.) throws immediately with an
   actionable message instead of silently reading state for the wrong
   PoolManager. Runs once per process (cached); the pure comparison logic
   (`checkStateViewBinding`) is unit-tested directly, including a
   case/checksum-insensitivity check, without needing a live RPC call.

3. **Exit-swap architecture note for Module 7 (`swap/`) — no code yet,
   recorded now so it isn't lost:** Robinhood Chain's UniversalRouter is
   a modified fork with a custom `minHopPriceX36` field, so hand-building
   v4 UniversalRouter calldata risks reverts. **`swap/` must delegate
   calldata construction** to one of:
   - GMGN swap execution (`gmgn-cli order quote` / `gmgn-cli order swap`
     — `gmgn-cli` is already a dependency via `discovery/gmgnCliClient.ts`
     for market data; this would be a second, distinct use of the same
     tool for execution), or
   - the Uniswap Trading API (`https://trade-api.gateway.uniswap.org/v1`,
     needs a new `UNISWAP_API_KEY` — not yet added to config, since
     there's no code using it yet).

   Both hand calldata construction to a party that already handles this
   chain's modified router correctly, instead of Lunex guessing at the
   modified ABI. This has **zero impact on what's already built**: pool
   selection (`pools/`) never touches the router at all.

4. **Position open/close confirmed to use `PositionManager.modifyLiquidities()`,
   not UniversalRouter.** So the future "open position" module (deploying
   the single-sided USDG LP) and everything already built in `pools/` are
   entirely unaffected by the router modification — only the exit-swap
   path (point 3) needs to route around it.

No code changes were needed for points 3-4 this round (confirmations for
future modules only); points 1-2 are implemented, tested (92/92 passing),
and verified end-to-end (config loads the real addresses correctly; see
test run in this session).

## Module 4 — strategies/ (LP range calculation)

Pure math, no I/O/RPC: [strategies/computeLpRange.ts](src/strategies/computeLpRange.ts)
takes a pool's real current state (`sqrtPriceX96`, `tickCurrent`,
`tickSpacing`, `currency0`/`currency1`, `decimals0`/`decimals1`) and
returns `{ ok: true, tickLower, tickUpper, diagnostics } | { ok: false, reason }`.
24 unit tests, all passing, all against real SDK tick math (no mocking of
the math itself).

1. **Architecture note surfaced before writing any code: `nearestUsableTick`/
   `TickMath`/`encodeSqrtRatioX96` only exist in `@uniswap/v3-sdk`'s public
   API — `v4-sdk` doesn't re-export them, even though it uses these exact
   three functions internally for its own tick math (verified by reading
   `v4-sdk`'s `Pool.js` and `priceTickConversions.js` source directly).**
   Since there's no v4-native alternative and hand-rolling tick-spacing
   rounding was explicitly ruled out, [blockchain/uniswapSdk.ts](src/blockchain/uniswapSdk.ts)
   now re-narrows the Module 3 "v4 ONLY" claim: it means "no v3
   AMM/trading logic" (no v3 `Pool`/`Position`/`Route`/fee-tier code),
   not "zero v3-sdk imports anywhere" — and exposes exactly these three
   pure tick-math functions as `v3TickMathUtils`, nothing else from
   v3-sdk (no `Pool`, no `FeeAmount`, no `TICK_SPACINGS`). Flagging this
   explicitly since it revises something stated in Module 3.

2. **Orientation (point 1) — the critical check, handled explicitly and
   tested in both directions.** A v4 tick is the raw ratio
   currency1/currency0 (confirmed from `Pool`'s own constructor docs and
   `encodeSqrtRatioX96`'s doc comment), independent of which currency is
   USDG. The function determines `usdgIsCurrency0` by direct address
   comparison against `config.quoteAsset.ADDRESS` (rejecting with
   `ok:false` if neither currency matches) and the tick-assignment logic
   fully branches on it:
   - USDG = currency1: raw ratio is directly "USDG per TOKEN." A
     single-sided-USDG position needs the range at/below the current
     tick (Uniswap mechanics: a position holds 100% currency1 when price
     is at/above its range) — `tickLower` = tick at half the raw ratio,
     `tickUpper` = current tick rounded **down** to strictly below.
   - USDG = currency0: raw ratio is "TOKEN per USDG," the *inverse* of
     the business price — halving the USDG-per-TOKEN price means the raw
     ratio *doubles*. Single-sided-USDG now needs the range at/above the
     current tick (100% currency0 when price is below the range) —
     `tickLower` = current tick rounded **up** to strictly above,
     `tickUpper` = tick at double the raw ratio.

   Verified with a cross-check test: constructing the same real-world
   price in both orientations produces byte-identical human-readable
   `diagnostics` prices despite completely different raw tick values in
   each case.

3. **Decimals (point 2) — used, but not where you might expect; flagging
   the finding for review.** Working through the math: scaling a raw
   ratio by a pure number (0.5x or 2x) commutes with each token's fixed
   decimal scalar, so the core `tickLower`/`tickUpper` computation is
   decimal-agnostic **by construction** as long as it stays entirely in
   the raw sqrtPriceX96/tick domain (which it does — see point 4).
   `decimals0`/`decimals1` are still required inputs, matching the
   requested signature, and are genuinely used — for the `diagnostics`
   block's human-readable USDG-per-TOKEN price strings (via
   `@uniswap/sdk-core`'s `Token`/`Price`, which need real decimals to not
   be wildly wrong there) — but a wrong decimals value can only ever
   corrupt those diagnostic strings, never the actual on-chain range.
   Test: `never lets decimals affect tickLower/tickUpper themselves`
   proves this directly (9-decimal vs 18-decimal input, identical output
   ticks). This is a deliberate, verified design choice being surfaced
   for review, not a silent assumption.

4. **Exact integer math throughout — zero floating point.** The 0.5x/2x
   raw-ratio sqrtPriceX96 values are computed via `encodeSqrtRatioX96`
   (an exact, integer-square-root-based ratio encoder) fed with exact
   BigInt ratios (`sqrtPriceX96^2` scaled by 2 or 1/2), then converted to
   ticks via `TickMath.getTickAtSqrtRatio` — no `Math.log`/`Math.sqrt`
   anywhere in the price-derivation path. Tick-spacing alignment is
   `nearestUsableTick` throughout; the "strictly below/above current"
   requirement is one provably-sufficient conditional adjustment on top
   (documented inline: `nearestUsableTick`'s nearest-rounding guarantees
   its result is within `tickSpacing/2` of the input, so one
   `± tickSpacing` step is always enough — never a loop, never a custom
   rounding algorithm).

5. **tickSpacing (point 5) is read from `input.tickSpacing` everywhere** —
   grep-clean of any hardcoded 60/200/etc. Tested explicitly with
   1/10/60/200/644/137.

6. **Explicit validation (point 6), never trusting the rounding helpers**:
   `tickLower < tickUpper`, both within `[MIN_TICK, MAX_TICK]`, both exact
   multiples of `tickSpacing` (`=== 0`, not just assumed) — all checked
   before returning `ok: true`. A tickSpacing too large for the 50% range
   (tested with `tickSpacing = MAX_TICK`) returns `{ok:false, reason}`,
   never a thrown exception. Every SDK call that can throw (extreme
   ticks near MIN/MAX bounds, invalid inputs) is inside a `try/catch`
   that converts to `ok:false` — tested with `expect(...).not.toThrow()`
   at ticks 5 away from each bound.

7. **Test coverage matches every requested case**: standard spacings
   (1/10/60/200) and custom/odd ones (644, 137); a deeply negative
   current tick (`-123456`) in both orientations, specifically to guard
   against the exact class of off-by-one bug found in Module 3's tick
   compression math; the large-tickSpacing degenerate-range rejection;
   both USDG-as-currency0 and USDG-as-currency1 explicitly; and a
   9-decimal-token-vs-18-decimal-USDG pairing.

Please review, especially points 2 and 3 as requested — point 3 in
particular is a place where my reasoning led somewhere different from
what the input signature might imply (decimals matter for display, not
for the range itself) and I want that checked before `capital/` is built
on top of this.

## Module 5 — capital/ + cooldown/ (and storage/'s first real use)

1. **A real, previously-hidden problem surfaced here and was fixed
   properly rather than routed around: Prisma 7 is a breaking
   architectural change from what Module 1 assumed.** Running the very
   first real migration (`prisma migrate dev`) failed immediately:
   `datasource.url` in `schema.prisma` is rejected outright (error
   P1012) -- Prisma 7 removed reading the connection URL from the schema
   entirely, and `new PrismaClient()` with no arguments now throws ("A
   driver adapter is required"). This wasn't guessable from Module 1;
   it only surfaced by actually running the CLI. Fixed by:
   - [prisma7.config.ts](prisma7.config.ts) (new, repo root) -- holds the
     connection URL for CLI/migration commands only (the filename itself
     is what the installed `prisma@7.10.0` CLI generates/expects,
     confirmed via a scratch `prisma init`).
   - [prisma/schema.prisma](prisma/schema.prisma) -- `datasource.url`
     removed; `provider = "sqlite"` remains (still a schema/migration-time
     SQL-dialect choice, not a runtime switch -- unchanged from Module 1's
     original design intent).
   - [storage/prismaClient.ts](src/storage/prismaClient.ts) (new) --
     the app's own runtime connection: builds an explicit driver adapter
     (`@prisma/adapter-better-sqlite3` or `@prisma/adapter-pg`, chosen
     from `config.database.provider`) and passes it to
     `new PrismaClient({ adapter })`. New dependencies:
     `@prisma/adapter-better-sqlite3`, `@prisma/adapter-pg`,
     `better-sqlite3`, `pg` (pinned to `better-sqlite3@^12.11.1`
     specifically, matching the adapter's own internal dependency, to
     avoid two different better-sqlite3 native builds coexisting).
   - `package.json` gained a `postinstall: prisma generate` script so a
     fresh `npm install` always produces a working client (the generated
     client lives in `node_modules/@prisma/client`, which is not
     committed).
   - Verified end-to-end multiple times in this session: real
     `prisma migrate dev`/`deploy`, real generated client, real SQLite
     file, real queries -- not just "should work."

2. **`cooldown/` is real, persistent storage from the start** -- per
   Module 1's explicit principle (never store critical state only in
   memory). [prisma/schema.prisma](prisma/schema.prisma) adds
   `TokenCooldown` (address, exitedAt, cooldownEndsAt), the first model
   in the project. [cooldown/cooldownLogic.ts](src/cooldown/cooldownLogic.ts)
   holds the pure time math (`computeCooldownEndsAt`,
   `computeCooldownStatus`), fully unit-tested with no DB. `PrismaCooldownRepository`
   ([cooldown/cooldownRepository.ts](src/cooldown/cooldownRepository.ts))
   implements `CooldownChecker` **directly** -- the exact interface
   `filters/screenCandidate()` has depended on since Module 2 -- so it's
   a drop-in real implementation, not a new/different shape. Addresses
   are normalized (checksummed then lowercased) before every read/write
   so a differently-cased lookup can't miss.
   [tests/cooldown/cooldownRepository.integration.test.ts](tests/cooldown/cooldownRepository.integration.test.ts)
   runs the actual `prisma migrate deploy` against a throwaway SQLite
   file and exercises the real repository (not mocked) -- worth the
   extra setup cost since local SQLite is cheap to test for real, unlike
   the RPC-backed integrations in earlier modules.

3. **`capital/` implements spec section 5 exactly, and is honestly
   incomplete where it has to be.** [capital/decideCapitalAllocation.ts](src/capital/decideCapitalAllocation.ts)
   is a pure function (`CapitalSnapshot -> CapitalAllocationResult`)
   covering: position size = 35% of the snapshot's free USDG balance
   (never a cached/original balance); max 3 active positions; max 90%
   of total portfolio (free + deployed) deployed, checked against what
   deploying *this* position would push the total to, not just current
   state (tested at the exact inclusive boundary, derived algebraically
   in the test rather than guessed). The ETH gas reserve check (spec:
   unlocked/TBD, default OFF) is wired in and extracted as its own
   `checkEthGasReserve()` pure function specifically so **both** states
   of this toggle can be unit-tested directly -- `config`'s
   frozen-at-import nature (same as every other module) makes flipping
   a live flag mid-test-suite impractical, so the parameters are passed
   explicitly instead of read from config in that one helper.
   "1 coin = 1 position" is deliberately NOT re-checked here -- that
   remains `filters/rules/duplicatePosition.ts`'s job (Module 2), a
   different concern (per-token) from this module's aggregate sizing.

   **What's honestly not built yet, and why:** `CapitalSnapshotProvider`
   (the port that would assemble a real `CapitalSnapshot`) has no
   concrete implementation. `activePositionsCount`/`totalDeployedUsdg`
   depend on `positions/` (Module 7, not built) actually tracking
   position state -- there's no honest way to know these numbers yet.
   Rather than ship a concrete provider that silently reports
   `totalDeployedUsdg: 0` (which would be actively wrong once positions
   are open), I left it as an interface only. The one piece that
   genuinely doesn't need `positions/` --
   [capital/usdgBalanceReader.ts](src/capital/usdgBalanceReader.ts),
   a real on-chain ERC20 `balanceOf` read via the viem client from
   Module 3 -- is built now: since USDG that's deployed into a position
   has physically left the wallet (`PositionManager.modifyLiquidities()`
   is a real transfer, not an allowance), the wallet's raw USDG balance
   directly **is** the free/available balance, no subtraction needed.

4. **Testing**: 28 new tests (15 capital, 12 cooldown, all passing),
   bringing the project to 143 total. Capital's suite includes an
   algebraically-derived exact-boundary test for the 90% cap (solved for
   the deployed amount that lands exactly on the cap, rather than
   picking a number and hoping) and full coverage of both ETH-gas-reserve
   states. Cooldown's suite is a genuine SQLite integration test, not a
   mock.

Please review, especially: the Prisma 7 adapter setup (point 1, since
every future module needing storage builds on this) and the deliberate
gap in `capital/` (point 3 -- confirming that leaving
`CapitalSnapshotProvider` unimplemented until `positions/` exists is the
right call, not a shortcut) before `execution/`/`blockchain/` or
`positions/` starts.

## Module 6 — execution/ + blockchain/ (transaction safety flow)

The module the spec calls "paling kritis." Implements spec section 10's
mandatory pipeline end to end: **Build -> Simulate -> Gas Check -> Nonce
Check -> Send -> Wait Receipt -> Verify On-chain -> Update State**, with
the two hard requirements called out explicitly in the spec:

> Kalau transaksi gagal, JANGAN langsung tandai state sebagai
> closed/deployed -- verifikasi state blockchain dulu.
> Implementasikan idempotency/crash-recovery: kalau bot restart di
> tengah proses ini, harus bisa resume/verify state, bukan mengulang
> transaksi atau menganggap gagal begitu saja.

### Design

[execution/executeCriticalTransaction.ts](src/execution/executeCriticalTransaction.ts)
is a single orchestrator, generic over any critical operation (deploy or
exit -- neither is built yet; this is the reusable machinery both will
sit on top of). Every pipeline step is an injected function
(`TxSafetyDeps`), which is what makes exhaustive failure-simulation
testing possible per the original instruction. Two design decisions
carry the actual safety guarantees:

1. **A `SIGNED` checkpoint not named in the spec, inserted deliberately.**
   The transaction is signed locally and its hash is computed from the
   signed payload itself (`keccak256(rawSignedTx)`) -- BEFORE any network
   call. Both are persisted at that point. This means the one network
   call that can fail in a truly ambiguous way (did the broadcast reach
   the node or not?) never has to be trusted either way: a resumed
   process already has the exact hash to look up, or can safely
   re-broadcast the identical already-signed bytes (a no-op if it already
   landed). Nothing is ever re-signed under a fresh nonce because of an
   uncertain network error.

2. **Every result carries `resumable: true|false`, and the two are never
   conflated.** `resumable: false` (definitive `FAILED`) only ever comes
   from an actual fact: a rejected simulation, an unaffordable gas check
   (both are pre-broadcast, so "no" is unambiguous), a receipt that came
   back `reverted` (an on-chain fact), or an explicit `verifyOnChain`
   mismatch. Every other outcome -- broadcast throwing, receipt-waiting
   throwing, any unexpected exception -- returns `resumable: true` and
   leaves the persisted status at the last real checkpoint, never
   advancing to `FAILED`. Calling `executeCriticalTransaction` again with
   the same `idempotencyKey` is how a restarted process resumes; a
   `VERIFIED` attempt short-circuits to a cached success and a `FAILED`
   one to a cached failure, so neither path silently repeats work.

### storage/ (extended)

[prisma/schema.prisma](prisma/schema.prisma) adds `TransactionAttempt`
(idempotencyKey, status, the JSON-encoded tx request, gasLimit/gasPrice
as real `BigInt` columns, nonce, rawTx, txHash, lastError).
[execution/transactionAttemptRepository.ts](src/execution/transactionAttemptRepository.ts)
is the Prisma-backed implementation; its own integration test (same
real-migration-against-a-throwaway-SQLite-file pattern as `cooldown/`'s)
specifically proves the trickiest part -- a `TxRequest`'s `bigint value`
field round-trips exactly through JSON storage, and `gasLimit`/`gasPrice`
round-trip as real bigints, not strings -- since silent bigint/JSON/Prisma
interop bugs are a real, easy-to-miss risk.

### blockchain/ (extended)

[blockchain/walletClient.ts](src/blockchain/walletClient.ts) (new) --
the executor's signing client (`viem`'s `WalletClient` +
`privateKeyToAccount`), used ONLY to sign locally, per the design above --
it never sends anything itself.
[execution/viemTxSteps.ts](src/execution/viemTxSteps.ts) provides the
real on-chain implementations of each pipeline step (simulate via
`client.call`, `estimateGas`, `getGasPrice`, pending-inclusive nonce via
`getTransactionCount(..., 'pending')`, sign, `sendRawTransaction`,
`waitForTransactionReceipt`). Flagged the same way every other live-RPC
integration in this project has been: correct by inspection, not
verifiable against a real chain from here, isolated behind `TxSafetyDeps`
so swapping any piece never touches the orchestrator.

[execution/gasAffordability.ts](src/execution/gasAffordability.ts) is a
pure function reusing `capital/`'s exact `checkEthGasReserve` toggle
(not a second copy of that logic) -- checked against the balance that
would remain *after* paying for the transaction.

### Testing

24 new tests (167 total): 14 for the orchestrator (the important ones --
every definitive-failure point, every ambiguous/resumable-failure point,
resume-without-re-signing, resume-without-re-broadcasting, idempotent
re-calls on both `VERIFIED` and `FAILED`, and two independent
`idempotencyKey`s never interfering), 4 for gas affordability, 6 for the
real Prisma repository. Also manually verified end-to-end through the
*actual* Prisma-backed repository (not the in-memory test double) in this
session: a full run to `VERIFIED`, then a second call with the same key
short-circuiting correctly.

Please review the two design decisions above (the `SIGNED` checkpoint and
the `resumable` split) before `positions/`, `exits/`, or any module that
will actually call `executeCriticalTransaction` for a deploy/exit gets
built.

## Revision 4 — Module 6 follow-up: broadcast classification + stuck-attempt tracking

Two gaps identified by explicit review of `executeCriticalTransaction`,
before any other module builds on top of it. For each: status is (b) --
added now, with new tests. Nothing was already handled; both were real
gaps.

### 1. Broadcast-time synchronous rejection vs. ambiguous failure

**Before this revision, every exception from `broadcastRaw` was treated
identically as `resumable: true`** -- confirmed by re-reading the code,
not assumed. Fixed:

- [execution/classifyBroadcastError.ts](src/execution/classifyBroadcastError.ts)
  (new, pure, unit-tested) classifies a broadcast error message into four
  buckets: `ALREADY_KNOWN`, `POSSIBLY_OURS` (`nonce too low` /
  `replacement transaction underpriced`), `DEFINITIVE_REJECTED`
  (`insufficient funds`), or `AMBIGUOUS` (everything else, unchanged from
  before -- the default was deliberately NOT made more aggressive).
  `nonce too high` is deliberately excluded from any definitive bucket
  per the review's own caveat about its context-dependent meaning.

- **Verified against the installed `viem`, not assumed**: `sendRawTransaction`
  does not go through viem's typed node-error wrapping (unlike
  `call`/`estimateGas`) -- it's a bare RPC call, so the raw node message
  text reliably ends up in a `Details: ...` line of `err.message` via
  viem's generic `RpcRequestError`. That's what makes plain substring
  matching correct here (documented in the file itself for future
  maintainers who might otherwise "improve" this into a more fragile
  `instanceof` check against viem's typed errors, which don't even apply
  to this call).

- **`ALREADY_KNOWN`** is treated as success (the payload is confirmed in
  the mempool), not a failure.

- **`DEFINITIVE_REJECTED`** (`insufficient funds`) -> `FAILED` with the
  new `failureCode: 'BROADCAST_REJECTED'` -- a distinct code from
  `REVERTED` (mined then reverted) or `SIMULATION_REJECTED`/
  `GAS_UNAFFORDABLE` (rejected pre-broadcast), per the request to
  distinguish these three failure origins, not collapse them into one
  generic `FAILED`.

- **`POSSIBLY_OURS`** (`nonce too low` / `replacement underpriced`) is
  the subtle one: both can mean either "an unrelated tx consumed this
  nonce" (our signed payload is permanently dead) OR "our own earlier
  broadcast of this exact payload already landed" (not a failure at all
  -- a resumed process retrying a broadcast that actually succeeded the
  first time would see exactly this). **Never guessed either way**: a
  new dependency, `getReceiptIfAvailable` (a single non-blocking lookup,
  unlike the polling `waitForReceipt`), checks for a receipt under our
  own locally-computed tx hash before deciding. Receipt found -> treated
  as success; not found -> `FAILED`/`BROADCAST_REJECTED`; the check
  itself throwing -> stays `resumable: true` (still refuses to guess).

- **Testing**: 8 new tests for the classifier (including case-
  insensitivity and the explicit "nonce too high stays AMBIGUOUS" case),
  plus 7 new orchestrator-level tests exercising each classification
  path end-to-end (already-known succeeds, insufficient-funds fails
  definitively and stays failed on a second call, nonce-too-low with a
  found receipt succeeds, nonce-too-low with no receipt fails, the
  receipt-check-itself-failing case, and an unrecognized error staying
  exactly as ambiguous as before).

### 2. Retry/staleness tracking for `resumable: true` attempts

**Before this revision, there was no limit or tracking at all** --
confirmed, not assumed. Added:

- `TransactionAttempt` gains `attemptCount` (incremented on every
  non-short-circuited call to `executeCriticalTransaction`) and
  `firstAttemptedAt` (set once, on the first such call).
- [config/constants.ts](src/config/constants.ts) adds
  `EXECUTION.STUCK_ATTEMPT_MAX_RETRIES` (5) and
  `EXECUTION.STUCK_ATTEMPT_MAX_AGE_MS` (10 minutes) -- explicitly
  revisable starting values, not spec-locked.
- [execution/stuckAttempt.ts](src/execution/stuckAttempt.ts) (new, pure)
  computes `isStuckAttempt()` from those two thresholds; never true for
  a terminal (`VERIFIED`/`FAILED`) attempt.
- Every `resumable: true` result from `executeCriticalTransaction` now
  carries a `stuck: boolean` field computed from this, so the immediate
  caller sees it without a separate query.
- `TransactionAttemptRepository` gains `findNonTerminal()` -- the query
  basis for a future `/status` command (Module 9+) to list attempts
  stuck in an ambiguous state, filtered by `isStuckAttempt`.
- **Deliberately NOT a push notification** -- per spec, Telegram stays
  fully on-demand-only; nothing here calls out, alerts, or interrupts
  anything. It only makes stuck attempts *findable* by query.
- **Testing**: 8 new tests for `isStuckAttempt` (terminal states never
  stuck regardless of counters, both threshold boundaries exactly),
  8 new orchestrator-level tests (attemptCount/firstAttemptedAt actually
  accumulate across resumed calls, `stuck:true` appears exactly at the
  retry threshold, a definitive failure is never reported as stuck, a
  short-circuited `VERIFIED` re-call doesn't inflate the counter), plus
  2 new repository integration tests (`failureCode`/`attemptCount`/
  `firstAttemptedAt` round-trip through real SQLite, `findNonTerminal`
  filters correctly).

### Net effect

33 new tests (200 total, all passing). Verified end-to-end again through
the real Prisma-backed repository (not just the in-memory test double):
an `insufficient funds` broadcast rejection correctly lands as `FAILED`
with `failureCode: 'BROADCAST_REJECTED'`, `stuck: false`, and is excluded
from `findNonTerminal()`.

`positions/`/`exits/` can now be built on top of `executeCriticalTransaction`
with both gaps closed.

## Module 7 — positions/ + monitoring/

Closes two honest gaps deliberately left open in earlier modules, then
builds real-time position monitoring (spec section 7) on top.

### positions/ closes Module 5's and Module 2's gaps

- [prisma/schema.prisma](prisma/schema.prisma) adds `Position` (token,
  full pool context decomposed for reuse, tick range, entry snapshot,
  status, and the `openIdempotencyKey`/`closeIdempotencyKey` linking each
  position to the `TransactionAttempt` that opened/will close it).
- **A real bug caught by the integration test, not assumed correct:**
  `entryUsdgRaw` was first modeled as a Prisma `BigInt` column. The very
  first test run failed with `RangeError: The bound string, buffer, or
  bigint is too big` -- a routine 18-decimal USDG amount (e.g. 1000 USDG
  = 10^21) already exceeds SQLite's 64-bit signed INTEGER range that
  Prisma's `BigInt` maps to (max ~9.2 * 10^18). This isn't an edge case,
  it's the normal case for any real position. Fixed the same way
  `entrySqrtPriceX96` was already (correctly) modeled -- as a decimal
  `String`, converted at the repository boundary. A dedicated test now
  round-trips an extreme value (`2^160 - 1`) through both fields to prove
  neither can silently overflow again.
- [positions/activePositionChecker.ts](src/positions/activePositionChecker.ts) --
  the real `ActivePositionChecker` implementation `filters/screenCandidate()`
  (Module 2) has depended on as a port since "1 coin = 1 position" was
  first designed.
- [positions/capitalSnapshotProvider.ts](src/positions/capitalSnapshotProvider.ts) --
  the real `CapitalSnapshotProvider` Module 5 explicitly left unbuilt.
  Combines `capital/`'s on-chain USDG balance read with the positions
  ledger. Two counts are deliberately different:
  `activePositionsCount` (the MAX_ACTIVE_POSITIONS=3 cap) counts
  OPENING+ACTIVE+CLOSING via a new `countNonClosed()`, since a position
  mid-open or mid-close is still a real capital commitment; but
  `totalDeployedUsdg` (the 90% portfolio cap) only sums confirmed-ACTIVE
  positions' `entryUsdgRaw`, since an OPENING position's USDG likely
  hasn't left the wallet yet -- summing both would double-count it
  against the on-chain free-balance read. Tested explicitly with all
  four statuses present at once.
- All repository tests follow the established pattern: pure-logic/adapter
  tests against an in-memory repository, plus a dedicated integration
  test running the real migrations against a throwaway SQLite file.

### monitoring/ (spec section 7: every 15s, independent of the 30-min screening cycle)

- [monitoring/computePositionMetrics.ts](src/monitoring/computePositionMetrics.ts) --
  pure function computing current price, PNL, fees-earned (converted to
  USDG), yield-to-date, and range status. Uses `@uniswap/v4-sdk`'s
  `Position` class (`.amount0`/`.amount1`) for the actual token-
  composition math -- verified by reading its source that these getters
  depend only on `pool.tickCurrent`/`pool.sqrtRatioX96` (scalars) and
  never call `Pool.swap()`, so -- unlike `pools/priceImpact.ts`'s exit-
  impact simulation -- this works identically for hooked pools, no
  special-casing needed. Reuses the exact orientation-handling discipline
  from `strategies/computeLpRange.ts` (a v4 tick is the raw ratio
  currency1/currency0, independent of which side is USDG).
- **Verification caught two real bugs, both in the test fixtures, not
  the function -- worth recording since they'd be easy to reintroduce.**
  A first manual check used an arbitrary placeholder `liquidity` number
  and got a nonsensical -85% PNL at an unchanged price; fixed by deriving
  liquidity honestly via the SDK's own `Position.fromAmount0`/
  `fromAmount1` for a real single-sided deposit (0% PNL at unchanged
  price, confirmed). The formal test suite then hit a second bug: it
  reused Module 4's "USDG=currency1" tick range ([-6960,-60], below
  entry) for the "USDG=currency0" case too, instead of mirroring it
  above entry ([60, 6960]) the way `strategies/computeLpRange.ts` itself
  requires -- silently making that fixture 100% TOKEN at entry instead of
  100% USDG, producing ~10^56-magnitude garbage. Both are documented
  inline in the test file so the same mistake isn't repeated.
- Confirmed properties, not just spot values: PNL is exactly 0 at the
  unchanged entry price (both orientations); once price is out of range
  on the far side, the position's raw token amount stops changing (only
  its USDG-equivalent valuation moves with price); both orientations
  agree on human-readable price and PNL for a mirrored scenario.
- [monitoring/monitorPositions.ts](src/monitoring/monitorPositions.ts) --
  the 15s loop reuses `discovery/scheduler.ts`'s `scheduleInterval`
  (same re-entrancy guard) rather than a second interval-runner. One
  position's live-state read failing never aborts the cycle for the
  others.
- **Deliberately not built yet, flagged rather than faked**: a concrete
  `LivePositionStateProvider` (reading a position's real liquidity/owed
  fees from the v4 PositionManager contract). Unlike `pools/`'s
  `StateView` integration (a well-known, stable periphery contract
  pattern), v4's PositionManager fee/liquidity accounting is materially
  less certain without documentation access, and a wrong guess here would
  silently corrupt PNL/fee numbers rather than fail loudly. Left as a
  port (`LivePositionStateProvider`) with no shipped implementation,
  same honesty standard as Module 5's `CapitalSnapshotProvider` gap --
  the orchestration around it (`runMonitoringCycle`) is fully built and
  tested against a mock.

### Testing

32 new tests (232 total): 15 for `positions/` (5 adapter/checker tests, 3
capital-snapshot tests, 7 real-SQLite integration tests), 17 for
`monitoring/` (13 for the metrics math covering both orientations and
the range-boundary properties above, 4 for the monitoring-cycle
orchestrator). Verified end-to-end again through the real Prisma-backed
repositories (not just in-memory doubles): created a position, confirmed
`PositionActivePositionChecker` reports it active via the real adapter.

Please review the two deliberate gaps (`LivePositionStateProvider`'s
missing concrete implementation, and the `activePositionsCount` vs
`totalDeployedUsdg` status-set distinction) before `exits/` -- which will
need both a real position-state reader (to know what it's closing) and
the OOR/PNL numbers this module produces -- gets built.

## Revision 5 — Module 7 follow-up: LivePositionStateProvider + a real CLOSING-window gap

### 1. LivePositionStateProvider -- implemented per the confirmed v4 fee-accounting spec

[monitoring/feesFromGrowth.ts](src/monitoring/feesFromGrowth.ts) (pure,
9 tests including the explicitly-requested wraparound cases) implements
the given formula exactly, with the uint256-wraparound handling: a
naive JS subtraction goes negative whenever the pool's fee-growth counter
has wrapped since this position's last snapshot, which would silently
produce garbage; tested with the exact boundary (`last = UINT256_MAX,
current = 0` -> delta of exactly 1) and adversarial wrapped inputs,
confirming the result is never negative.

[monitoring/positionStateReader.ts](src/monitoring/positionStateReader.ts)
(`PositionManagerLivePositionStateProvider`) implements the three-step
flow exactly as specified: `getPositionInfo` (owner = the PositionManager
contract's own address, salt = `bytes32(tokenId)` via `numberToHex(...,
{size:32})`, tested separately for tokenId 0/small/large) +
`getFeeGrowthInside`, then `feesFromGrowth` for each side.
`positionTokenId` was already on the `Position` ledger since Module 7 --
confirmed, no schema change needed. [blockchain/abis/v4StateView.ts](src/blockchain/abis/v4StateView.ts)
gains both functions, with a doc comment distinguishing them (confirmed
spec, not a guess) from the four Module-3-era functions in the same file
(still best-effort/unconfirmed).

**A real interface bug surfaced while wiring this in, fixed along the
way**: `LivePositionStateProvider.getLiveState()` was originally typed to
take `(positionTokenId, pool)` -- but `pool` (`PositionPoolContext`)
doesn't carry `tickLower`/`tickUpper`, and both `getPositionInfo` and
`getFeeGrowthInside` need the position's own tick range, not just the
pool's identity. That version of the interface literally could not have
been implemented. Fixed to take the full `PositionRecord`; updated the
one call site (`monitorPositions.ts`) and its test.

### 2. The CLOSING-window gap -- real and unsafe, not just theoretical; fixed

Worked through with concrete numbers rather than intuition, since the
abstract reasoning ("both sides of the 90% check are missing the same
value, so it should cancel out") turns out to be **wrong** -- it doesn't
cancel out, because the projected-deployed side adds the NEW position on
top of an already-too-low base while the cap side is also too low, and
they don't move together correctly:

> 1 ACTIVE position (300) + 1 CLOSING position (300) + 100 free. TRUE
> total portfolio = 700; the closing position's LP hasn't actually been
> removed yet for most of the exit flow (Remove Liquidity -> Collect Fees
> -> ... -> Verify), so its capital is still fully at risk -- true at-risk
> = 600, true 90% cap = 630, true room for a new position = 30. The
> pre-fix code summed `entryUsdgRaw` over ACTIVE only, seeing
> totalDeployedUsdg=300, totalPortfolio=400, cap=360 -- enough apparent
> room to approve a new 35-sized position (35% of the 100 free), pushing
> TRUE exposure to 635, over the TRUE 630 cap.

The gap existed because a CLOSING position's capital was, for most of
its lifecycle, counted in **neither** `freeUsdgBalance` (a direct wallet
read -- correctly excludes it, since it hasn't been withdrawn yet) **nor**
`totalDeployedUsdg` (previously summed ACTIVE only) -- exactly the
"disappears from the system's view" window the question asked about,
confirmed to exist rather than ruled out.

**Fix**: [positions/types.ts](src/positions/types.ts) adds
`findDeployedPositions()` (ACTIVE + CLOSING, implemented in both the
Prisma repository and the in-memory test double), and
[positions/capitalSnapshotProvider.ts](src/positions/capitalSnapshotProvider.ts)'s
`totalDeployedUsdg` now sums over that instead of ACTIVE-only.
`findAllActive()` (ACTIVE only) is kept as-is for `monitoring/`'s
per-position tracking -- a different concern with a different correct
answer, deliberately not conflated with the capital-snapshot method.
OPENING remains correctly excluded from `totalDeployedUsdg` (that
capital is still in the wallet, already counted via `freeUsdgBalance`;
adding it here too would double-count it in the other direction).

**Invariant tests, not just the fixed formula**:
[tests/positions/capitalSnapshotProvider.test.ts](tests/positions/capitalSnapshotProvider.test.ts)
reproduces the exact worked example above end-to-end through
`decideCapitalAllocation` (the real consumer, not just the snapshot in
isolation) and confirms it's now correctly REJECTED; a second variant
with a smaller closing position confirms a deployment that genuinely has
room is still ALLOWED (proving the fix isn't just "always reject during
CLOSING"); a third confirms that once a position reaches CLOSED, its
capital correctly drops out of `totalDeployedUsdg` as the wallet balance
read picks it up instead -- no window, no double-count, at any stage of
the lifecycle.

### Testing

19 new tests (245 total): 6 for `feesFromGrowth` (including wraparound),
3 for the salt encoding, 1 new repository integration test for
`findDeployedPositions`, and for the capital-snapshot gap itself: 1
updated test (now correctly includes CLOSING) plus 3 new invariant tests
(reject-when-should, allow-when-should, drops-out-once-CLOSED).

Both items from the review are done, not deferred. `exits/` can now be
built: it has a real position-state reader to know what it's closing,
and the capital accounting it will read stays correct throughout the
CLOSING window it's responsible for driving.

## Revision 6 — the mirror-image gap: OPENING, not just CLOSING

Before `exits/` actually started, one more question from review, aimed
at the opposite end of the position lifecycle: Revision 5 fixed the
CLOSING-window gap, but its own text (above) claims "OPENING remains
correctly excluded... that capital is still in the wallet, already
counted via `freeUsdgBalance`" -- is that actually true throughout the
*whole* OPENING window, or only at the instant before anything starts?

**When does OPENING start, and when does the on-chain balance actually
drop?** Traced against the Module 6 transaction-safety pipeline: the
`Position` row is created (status `OPENING`) *before*
`executeCriticalTransaction` is even called -- it has to be, since the
same row's `openIdempotencyKey` is what makes the whole
Build->Simulate->GasCheck->NonceCheck->Send->WaitReceipt->VerifyOnChain
pipeline resumable after a crash. And the wallet's on-chain USDG balance
only decreases once the mint transaction is *mined* -- not at `SIGNED`,
not at broadcast/`SENT` -- that's just how a blockchain works, not a
design choice here. So for the entire span from "row created" through
BUILT/SIMULATED/GAS_CHECKED/NONCE_ASSIGNED/SIGNED/SENT/waiting-for-
CONFIRMED, the capital being deployed is still, physically, sitting in
the wallet's on-chain balance.

**Proved with the same worked-example method as Revision 5, not just
narrative reasoning** -- three sequential OPENING attempts, none yet
mined, each sized via `decideCapitalAllocation` against the pre-fix
`freeUsdgBalance` (a raw, unadjusted on-chain read):

> Wallet actually holds 1000 USDG on-chain (nothing mined yet, so this
> never changes across the three attempts). Attempt A: free=1000 (raw
> balance, no OPENING adjustment) -> sized at 35% = 350, Position row
> created at OPENING. Attempt B: free is STILL reported as 1000 (the
> pre-fix code never adjusted for A's still-unmined 350) -> sized at 35%
> of 1000 = 350 again. Attempt C: same story -> 350 again. Three
> approvals totaling 1050 USDG against a wallet that only ever had 1000
> -- an overcommit, and unlike the CLOSING gap (where capital vanished
> from both sides of the ledger), here the SAME money is double-counted
> as "free" by every subsequent sizing decision until something mines.

This rules out the "serialization already prevents it" possibility the
question raised: nothing in the 30-minute screening cycle or the
max-1-deployment-per-cycle rule stops a *previous* cycle's still-unmined
OPENING position from being counted as fully free capital by the
*current* cycle's sizing decision -- mining time is not bounded by the
screening cycle. The gap is real, confirmed by test, not just argued
away.

**Why the CLOSING fix's mechanism ("just add the status to the
deployed-sum") doesn't transfer as-is**: CLOSING capital has already
left the "free" side entirely (the LP hasn't been removed, so the
wallet never had it back) -- adding it to `totalDeployedUsdg` alone was
enough, no double-counting risk. OPENING capital is different: it is
STILL physically present in `onChainBalance`. Adding OPENING to
`totalDeployedUsdg` without also removing it from `freeUsdgBalance`
would double-count it -- the opposite failure mode, appearing as an
artificially LOW cap headroom instead of a real gap, but still wrong.

**Fix -- two halves, together**, in
[positions/capitalSnapshotProvider.ts](src/positions/capitalSnapshotProvider.ts):

```
reservedForOpening = sum(entryUsdgRaw for OPENING positions)
freeUsdgBalance     = onChainBalance - reservedForOpening   (never < 0)
totalDeployedUsdg   = sum(entryUsdgRaw for OPENING + ACTIVE + CLOSING)
```

[positions/types.ts](src/positions/types.ts)'s `findDeployedPositions()`
now returns OPENING + ACTIVE + CLOSING (previously ACTIVE + CLOSING,
per Revision 5), implemented identically in the Prisma repository and
the in-memory test double; `countNonClosed()` already covered all three
non-CLOSED statuses and needed no change.

**Algebraic proof the fix holds for any status mix**, not just the
worked example:

```
freeUsdgBalance + totalDeployedUsdg
= (onChainBalance - OPENING_sum) + (OPENING_sum + ACTIVE_sum + CLOSING_sum)
= onChainBalance + ACTIVE_sum + CLOSING_sum
```

...which is exactly the true total: `onChainBalance` already includes
every OPENING position's still-unspent capital (it never left the
wallet), plus whatever's genuinely locked away in ACTIVE/CLOSING LPs.
`OPENING_sum` cancels out algebraically regardless of how many
positions are in which state.

**Testing**: 2 new invariant tests in
[tests/positions/capitalSnapshotProvider.test.ts](tests/positions/capitalSnapshotProvider.test.ts)
-- one reproduces the exact three-attempt worked example above
end-to-end through `decideCapitalAllocation` and confirms total
committed capital now stays within the true on-chain balance at every
step; a second runs repeated OPENING attempts to whichever cap fires
first (position-count or balance) and confirms the
`freeUsdgBalance + totalDeployedUsdg == onChainBalance` invariant holds
at every single step regardless of which cap eventually stops further
deployment. Plus 1 existing unit test and 1 integration test
(`findDeployedPositions includes OPENING, ACTIVE, and CLOSING but
excludes CLOSED`) updated to match the new status set. 247 total tests
(2 net new), full typecheck/build/test suite clean, and confirmed
end-to-end against a real Prisma+SQLite-backed repository (not just the
in-memory test double) via a throwaway smoke script exercising three
sequential OPENING deployments through the real migration-backed DB.

Answering the original question directly: yes, the window is real
(mirroring CLOSING, but in the opposite direction -- capital wrongly
counted as free, not wrongly counted as neither free nor deployed), and
it is now fixed and tested before `exits/` begins.

## Revision 7 — FAILED deploys: a gap one layer below capitalSnapshotProvider, not in it

One more question before `exits/`, in the same worked-example style as
Revisions 5 and 6, this time about the OTHER way an OPENING position can
resolve: not "mined" (Revision 6) but DEFINITIVELY FAILED --
`executeCriticalTransaction` returning `{ ok: false, resumable: false }`
(pre-broadcast rejection, synchronous broadcast rejection, or an
on-chain revert). None of those spend the wallet's USDG -- the position's
`entryUsdgRaw` never actually leaves the wallet, ever.

**Checked directly in code, not assumed**: [positions/types.ts](src/positions/types.ts)'s
`PositionStatus` was `'OPENING' | 'ACTIVE' | 'CLOSING' | 'CLOSED'` --
**no `FAILED` value existed at all**. `PositionRepository` had exactly
three status-changing methods: `markActive`, `markClosing`, `markClosed`
-- **no method existed to move a row out of `OPENING` on failure**.
[positions/capitalSnapshotProvider.ts](src/positions/capitalSnapshotProvider.ts)'s
`reservedForOpening` filters strictly on `p.status === 'OPENING'`, and
`totalDeployedUsdg` sums `findDeployedPositions()` -- both Prisma's and
the in-memory repository's version of that method query
`NON_CLOSED_STATUSES = ['OPENING', 'ACTIVE', 'CLOSING']`. So the honest
answer to "is FAILED excluded from both sums" is: there was no code path
that could ever produce a Position row with a FAILED-like status in the
first place -- a failed deploy's row just stays `OPENING`, forever,
because nothing was ever built to move it anywhere else.

**This makes it a different, and worse, class of bug than Revisions 5/6**:
those were bounded *timing windows* that closed on their own once a
transaction mined. This one never closes on its own -- a stuck row stays
wrong until the database is edited by hand.

**Proved with the same worked-example method**, in
[tests/positions/capitalSnapshotProvider.test.ts](tests/positions/capitalSnapshotProvider.test.ts):

> Wallet genuinely holds 1000 USDG on-chain. One real ACTIVE position
> (100). A second, unrelated deploy attempt (B, sized 850 in some
> earlier cycle) fails definitively -- B's row stays `OPENING` forever,
> pre-fix, because nothing could move it. Snapshot: free=150 (1000-850,
> wrong -- should be 1000), deployed=950 (100+850, wrong -- should be
> 100). The two numbers still sum correctly (1100, matching true
> portfolio) -- B's capital doesn't *vanish* from the ledger, it's stuck
> *double-committed* forever, the opposite failure mode from
> "disappearing." Feeding this into `decideCapitalAllocation`: true state
> has 900 USDG of headroom under the 90% cap and should approve a 350
> deployment, but the phantom reservation shrinks the sizing to 52.5 and
> the phantom deployed-sum trips the 90% cap anyway -- **wrongly
> REJECTED**, permanently.

A second worked example shows the same failure mode needs no large
capital at all: **three trivial 10-USDG failed-and-stuck positions**,
with zero real ACTIVE positions and 970 USDG sitting completely free,
permanently exhaust `MAX_ACTIVE_POSITIONS` (3) on their own --
`decideCapitalAllocation` rejects with `"max active positions reached
(3/3)"` forever, a total lockout caused by 30 USDG that was never
actually spent.

**Fix -- one layer below `capitalSnapshotProvider.ts`, not in it**:
[positions/types.ts](src/positions/types.ts) adds `'FAILED'` to
`PositionStatus` and a new `markFailed(id)` method to the
`PositionRepository` interface, implemented identically in
[positions/positionRepository.ts](src/positions/positionRepository.ts)
(Prisma) and the in-memory test double. `prisma/schema.prisma`'s
`status` column is an unconstrained `String` (chosen deliberately back
in Module 7, precisely so new statuses never need a migration), so this
required no schema migration -- just the new value and the method to set
it. **No change was needed in `capitalSnapshotProvider.ts` itself**:
`'FAILED'` is simply never a member of `NON_CLOSED_STATUSES`, the same
bucket `'CLOSED'` already sits outside of, so once a row is marked
`FAILED` it automatically drops out of `reservedForOpening` and
`totalDeployedUsdg` with zero additional filtering logic -- the entire
fix is making the OPENING-to-FAILED transition possible at all.

**Testing**: 3 new tests -- 2 invariant tests in
`capitalSnapshotProvider.test.ts` reproducing both worked examples above
end-to-end through `decideCapitalAllocation` (confirming the wrongful
rejection pre-`markFailed` and the correct approval, at the true 350
size, post-`markFailed`), and 1 new integration test in
[tests/positions/positionRepository.integration.test.ts](tests/positions/positionRepository.integration.test.ts)
confirming `markFailed` against a real migration-backed SQLite DB
correctly excludes the row from `findDeployedPositions`,
`countNonClosed`, and `findActiveByToken`. 250 total tests (3 net new),
full typecheck/build/test suite clean, and confirmed end-to-end via a
throwaway smoke script against a real Prisma+SQLite repository
reproducing the exact 100/850/1000 scenario above.

**REQUIRED when the open-position orchestrator is built (not optional,
not a nice-to-have)**: this fix adds the *capability* to correctly
resolve a failed deploy -- it does not yet wire `markFailed` into an
automatic caller, because no code yet exists that calls
`positions.create()` and `executeCriticalTransaction` together in the
first place (that orchestrator hasn't been built as a module yet).
Whatever module ends up owning the open-deployment flow **MUST** call
`positions.markFailed(id)` in the branch where `executeCriticalTransaction`
returns `{ ok: false, resumable: false }`, the same way it will call the
existing `markActive` on success and a future `exits/`-adjacent caller
calls `markClosed`. This is not a suggestion left for whoever writes
that module to rediscover -- skipping it silently reintroduces the
exact permanent lockout proved above (Revision 7) AND, transitively, the
"a failed token can never be retried" bug proved in Revision 8 below,
since both `capital/` and `filters/`'s duplicate-check read from the
same `OPENING` status this orchestrator is responsible for clearing.
Concretely, the orchestrator's failure branch needs:
```
const result = await executeCriticalTransaction(...);
if (!result.ok && !result.resumable) {
  await positions.markFailed(positionId);
}
```
placed at the point where a definitive failure is first observed --
there is no other correct place to put it, since `markFailed` is the
only thing that ever moves a row out of `OPENING` on that path.

This closes the third capital-accounting question raised before
`exits/`: OPENING (Revision 6), CLOSING (Revision 5), and FAILED
(Revision 7) are all correctly reflected in `freeUsdgBalance` and
`totalDeployedUsdg`, with a worked-example proof and invariant test for
each. One more consumer of `PositionStatus` remained unchecked at this
point -- see Revision 8 immediately below for the final green light.

## Revision 8 — the last PositionStatus consumer: ActivePositionChecker (the "1 coin = 1 position" duplicate-check)

One more question before `exits/` actually starts: Revision 7 fixed
`capital/`'s accounting for a FAILED deploy, but `capital/` isn't the
only consumer of `PositionStatus` -- Module 2's duplicate-check
(`ActivePositionChecker`, used by `screenCandidate()` to reject a token
that already has an open position) reads it too. Does it use the same
status set as `activePositionsCount`, or an independent one that could
have missed the FAILED fix?

**Checked directly in the implementation, not inferred from structure**:
[positions/activePositionChecker.ts](src/positions/activePositionChecker.ts)'s
`PositionActivePositionChecker.hasActivePosition()` calls
`positions.findActiveByToken()` -- the exact same repository method
`decideCapitalAllocation`'s duplicate-check path never touches, but
which the CLOSING/OPENING/FAILED revisions above already established is
built on `NON_CLOSED_STATUSES` (Prisma:
[positionRepository.ts](src/positions/positionRepository.ts)'s
`const NON_CLOSED_STATUSES = ['OPENING', 'ACTIVE', 'CLOSING']`, queried
via `status: { in: NON_CLOSED_STATUSES }`) and the identical
`NON_CLOSED` set in
[tests/positions/inMemoryPositionRepository.ts](tests/positions/inMemoryPositionRepository.ts)
-- the SAME set `countNonClosed()` and `findDeployedPositions()` use.
Not a coincidence of similar-looking code: it is the literal same
constant. `'FAILED'` is not a member, so it was already excluded here
the moment Revision 7 landed -- no additional code change was needed for
`ActivePositionChecker` itself.

**Proved, not assumed** -- per the same review standard as the three
prior revisions, "uses the same list so it must already be fine" is
exactly the kind of structural-similarity reasoning that turned out
wrong for the CLOSING gap (Revision 5), so it was verified with an
explicit test rather than accepted on inspection alone. New test in
[tests/positions/activePositionChecker.test.ts](tests/positions/activePositionChecker.test.ts):
create a position (OPENING), confirm `hasActivePosition()` reports
`true` (matching the pre-existing "still OPENING counts" test just above
it), call `markFailed()`, then confirm `hasActivePosition()` flips to
`false` -- proving a token whose deploy definitively failed is
immediately free to be screened and retried again, not permanently
rejected by `screenCandidate()` on every future 30-minute cycle the way
it would have been before Revision 7's `markFailed` existed (when the
row was stuck at `OPENING` forever, `hasActivePosition()` would have
kept returning `true` forever too -- the exact same permanent-lockout
shape as the capital-accounting bug, just surfacing through a different
consumer of the same stuck status).

**Testing**: 1 new test in `activePositionChecker.test.ts`. 251 total
tests (1 net new since Revision 7's 250), full typecheck/build/test
suite clean.

No gap found here -- `ActivePositionChecker` was already correct, and is
now provably so rather than presumed so. This was the last remaining
consumer of `PositionStatus` in the codebase (`findAllActive` is
ACTIVE-only by design for `monitoring/`, and is unaffected by FAILED
either way, since a FAILED position was never ACTIVE). Combined with the
now-explicit REQUIRED note in Revision 7 above -- so the still-unbuilt
open-position orchestrator wires `markFailed` in from its first
commit instead of reintroducing this as a fourth independently
rediscovered bug -- this is the final green light: `exits/` can now be
built.

## Module 8 — exits/ + swap/

The highest-risk module so far: this is the one that actually sends money
back out of the wallet. Reviewed with the same rigor as the four
`capital/` revisions above -- every design decision below was checked with
a plan, refined through one round of explicit correction before any code
was written, and every claim is backed by a passing test, not narrative
reasoning alone.

### The two things the original design didn't fully resolve, settled before coding started

1. **The failed-exit state machine is not a single revert-to-ACTIVE rule.**
   The exit flow is two separate on-chain transactions -- remove-liquidity
   (+ collect fees, one tx) then a TOKEN->USDG swap (a second, independent
   tx) -- and a definitive failure means something different depending on
   *which* leg failed. See "The failed-exit state machine" below.
2. **PNL Protection never independently closes a position.** It only
   retargets Trailing TP's arm threshold; it is not a fifth member of the
   close-decision priority list, even though it sits at that position in
   the priority ordering.

### Plan review round: GMGN ruled out for the exit swap

The first draft of this module's plan proposed GMGN for the TOKEN->USDG
swap leg (already a dependency since Module 2, no new external key). This
was rejected in review: GMGN is confirmed, via reference production code,
to only swap out to native ETH -- not directly to a stablecoin like USDG.
Using it here would have silently turned the two-transaction exit flow
into three (remove-liquidity, TOKEN->ETH, ETH->USDG), invalidating the
whole two-leg failure-state-machine design before it was even built.
Switched to the **Uniswap Trading API** (`swap/tradingApiClient.ts`), a
general-purpose router expected to support TOKEN->USDG in one hop --
preserving the two-transaction design. `UNISWAP_API_KEY` +
`UNISWAP_TRADING_API_BASE_URL` added to config; the exact endpoint/JSON
shape is flagged as unverified from here (no network access to check real
API docs) and isolated to one file, `swap/tradingApiMapper.ts` -- same
"best-effort, unconfirmed, flagged for later verification" treatment
already used elsewhere in this project (e.g.
`blockchain/abis/v4StateView.ts`).

Structural validation of any externally-sourced swap calldata --
adapted from a pattern given in review, generalized to a provider-agnostic
shape -- happens in `swap/validateSwapQuote.ts` before anything is ever
signed: chain match, well-formed `to`/`data`, the amount the calldata was
built for matches what was actually requested, and a sane minimum-received
figure when that protection is enabled. Treated as untrusted external
data, same principle already applied to GMGN discovery responses
elsewhere in this project. Pre-broadcast simulation for both exit legs
turned out to need no new code at all: `executeCriticalTransaction`'s
`SIMULATED` checkpoint (an `eth_call` before broadcast) already runs
unconditionally for every critical transaction in this project, including
both of these.

### Follow-up review: Trading API routing restriction + Permit2 handling

A second round of review, after the module above was believed complete,
caught something the original design hadn't accounted for: the Trading
API's `/quote` response carries a `routing` field that can be `CLASSIC`,
`WRAP`, `UNWRAP`, or `BRIDGE` (normal flow -- call `/swap`, get raw
calldata, sign+broadcast it ourselves) **or** `DUTCH_V2`, `DUTCH_V3`, or
`PRIORITY` (UniswapX -- a completely different flow: sign an off-chain
ORDER, submit it to `/order`, and wait for a third-party filler to execute
it). There is no transaction for `executeCriticalTransaction` to
build/simulate/broadcast/verify in the UniswapX case at all -- it is
flatly incompatible with this project's entire transaction-safety
pipeline, not just undesirable.

**Fix**: `swap/tradingApiClient.ts`'s quote/swap requests now send a
`protocols` field restricted to classic AMM routing
(`CLASSIC_ONLY_PROTOCOLS = ['V2', 'V3', 'V4']`, best-effort/unverified
exact values, same flagged treatment as everything else about this API).
Critically, **the request-side restriction is never trusted alone** --
`swap/tradingApiMapper.ts`'s `parseQuoteResponse` independently
re-verifies the response's `routing` field every time, and throws a
dedicated `TradingApiUnsupportedRoutingError` (naming the offending
routing type) if a UniswapX type comes back anyway, rather than ever
attempting to process it as ordinary calldata.

**Permit2**, the second issue caught in the same review pass: the
Trading API's default flow can require a Permit2 signature -- an
off-chain EIP-712 signature, not a transaction -- before `/swap` will
produce usable calldata. This project has no EIP-712 signing capability
anywhere; every other integration point (deploy, remove-liquidity, this
swap's own calldata) signs and broadcasts a real transaction through
`executeCriticalTransaction`. Rather than half-implement signing as a
one-off special case, the request now explicitly asks the API to disable
Permit2 (`x-permit2-disabled` header, best-effort/unverified name), and
`parseQuoteResponse` independently verifies the resulting quote's
`permitData` is actually `null` -- throwing a dedicated
`TradingApiPermitRequiredError` (never silently guessing or half-signing)
if the API still wants a permit despite the opt-out request.

When the opt-out holds, the quote's `allowanceTarget` names an ordinary
ERC20 spender, handled by a new, genuinely conditional third leg:
[exits/approveTx.ts](src/exits/approveTx.ts) -- a plain `approve()`
transaction, through the exact same `executeCriticalTransaction` pipeline
as everything else, run only when `needsApproval(currentAllowance,
amountInRaw)` is true (a fresh on-chain read, never assumed stale or
assumed sufficient). This is consistent with the rest of the codebase's
architecture (every critical operation is a signed+broadcast+verified
transaction) in a way that implementing EIP-712 signing would not have
been.

**The approve leg shares the swap leg's failure-state-machine branch, not
a fourth one**: since the approve leg only ever runs AFTER
remove-liquidity has already reached `VERIFIED` (LP already gone), a
definitive approve failure gets exactly the same response as a definitive
swap failure -- stay `CLOSING`, bump the shared `ExitState.swapAttemptCount`,
retry with fresh `:approve:${n}`/`:swap:${n}` keys next attempt. Treating
approve+swap as one combined "get TOKEN into USDG" unit of work (rather
than inventing a fourth counter/branch) was a deliberate simplification,
matching the existing principle that this half of the exit has no LP left
to revert to regardless of which specific step within it fails.

**Price impact logging/gating moved from `swapTx.ts` into `executeExit.ts`**
as part of this same pass: `executeExit` now fetches ONE quote per attempt
(immediately after remove-liquidity verifies) and reuses it for both the
allowance check and the swap build, rather than `swapTx.ts` fetching its
own quote internally -- fetching two separate quotes (one implicitly for
approve-checking, one for the swap) risked the approve amount and the
swap amount silently disagreeing if price moved between the two calls.

**Testing**: `tests/exits/approveTx.test.ts` (7 tests -- calldata shape,
`needsApproval` boundary cases, verification against on-chain allowance);
`tests/swap/tradingApiMapper.test.ts` extended with a routing-restriction
suite (parameterized over all 3 UniswapX types, confirming each is
rejected with the dedicated error, confirming all 4 classic types are
accepted, confirming an unrecognized routing type is rejected rather than
assumed safe) and a Permit2 suite (null/absent accepted, non-null
rejected with the dedicated error); `tests/swap/tradingApiClient.test.ts`
(new file, 8 tests -- confirms `protocols` and the permit2-disable header
are actually sent on both `/quote` and `/swap` requests, confirms the API
key travels via header never URL/body, confirms both new error types
surface correctly through the real HTTP-call path with a mocked
`fetch`); `tests/exits/executeExit.test.ts` gained 6 tests covering the
approve leg's three paths (skipped when unnecessary, runs and succeeds,
runs and fails both definitively and ambiguously) integrated into the
full state machine. Confirmed end-to-end against a real Prisma+SQLite
repository via a second throwaway smoke script (insufficient allowance ->
approve leg runs -> verifies -> swap runs -> `CLOSED`).

### The failed-exit state machine (the part reviewed most strictly)

The exit flow is up to THREE separate `executeCriticalTransaction` calls
(two mandatory, one conditional):

```
Tx A: REMOVE_LIQUIDITY + COLLECT_FEES  (one tx -- v4's BURN_POSITION +
                                         TAKE_PAIR settles both principal
                                         and accrued fees together;
                                         verified by reading
                                         @uniswap/v4-sdk's
                                         PositionManager.js source)
Tx A.5 (conditional): APPROVE  (plain ERC20 approve() -- only when the
                                 swap quote's allowanceTarget isn't
                                 already sufficiently approved; the
                                 Permit2 opt-out, see the follow-up
                                 review section above)
Tx B: SWAP (TOKEN -> USDG, via the Trading API)
```

**Tx A fails definitively, before ever reaching VERIFIED**: the LP is
still 100% intact -- nothing changed on-chain. `positions/types.ts` gains
`markExitFailed(id)` (Prisma + in-memory), reverting status CLOSING ->
ACTIVE and clearing `closeIdempotencyKey`, so the next attempt gets a
brand-new key rather than ever resuming the dead one -- exactly the fix
originally proposed for this case, and it is correct here.

**Tx B fails definitively, AFTER Tx A already reached VERIFIED**: the LP
is genuinely gone -- liquidity is 0, the wallet holds raw TOKEN, USDG
hasn't arrived. Reverting to ACTIVE here would misrepresent reality (no LP
left to compute PNL against). The position correctly **stays CLOSING**;
`ExitState.swapAttemptCount` (new Prisma model, see below) is incremented,
and the retry derives a **fresh** swap-specific idempotency key
(`${closeIdempotencyKey}:swap:${swapAttemptCount}`) while the
remove-liquidity key stays untouched -- so Tx A's cached `VERIFIED` result
is found and short-circuited for free, never rebuilt/re-signed/
re-broadcast, on a Tx-B-only retry. This sub-case is exactly what a naive
"always revert to ACTIVE" fix (mirroring the `markFailed`/Revision-7
pattern literally) would have gotten wrong -- caught during plan review,
before any code existed, not discovered after the fact.

No `capitalSnapshotProvider.ts` change was needed for either branch:
reverting to ACTIVE keeps the position in `NON_CLOSED_STATUSES` (still
correctly deployed, still occupies a slot); staying at CLOSING is already
unconditionally included by Revision 5's fix, regardless of which CLOSING
sub-phase (LP-still-there vs. LP-already-removed-swap-pending) the
position is actually in.

**Tests** (`tests/exits/executeExit.test.ts`, 10 tests): both branches
proven with concrete scenarios, including a **counter-proof** of what
"stuck forever" would look like -- calling `executeCriticalTransaction`
again with the same dead key and confirming it returns the cached failure
forever without ever rebuilding, which is exactly why clearing/rotating
the key is required, not optional. Also covers the ambiguous/resumable
case for both legs (retried with the *same* key, position untouched) and
the full happy path. Confirmed end-to-end against a real Prisma+SQLite
repository via a throwaway smoke script (both branches, plus the
fresh-key retry actually reaching `CLOSED`).

### Exit trigger priority

```
1. SAFETY_EXIT     -- abnormal condition, close immediately, no confirm timer
2. HARD_STOP_LOSS   -- PNL <= -15%, close immediately, no confirm timer
3. (PNL_PROTECTION applied here -- never itself closes)
4. TRAILING_TP      -- peak tracking + 2% drawdown + 15s confirm timer
5. OOR              -- 30 min out-of-range grace timer
```

(1)/(2) are pure capital-protection and short-circuit everything else.
(3) sits between (2) and (4) because it changes what threshold (4) arms
at, and that must take effect the same tick it flips -- it never produces
a `closeReason` of its own. (4) before (5): a timer-confirmed
profit-taking signal represents money already on the table, which takes
precedence over (5)'s capital-efficiency (not risk) concern.

When a higher-priority trigger fires, lower-priority timer state is left
completely untouched for that tick (`resolveExitDecision.ts`'s
short-circuit branches return the exit state object unmodified) -- proven
with the user's own example: a price crash that trips BOTH
`HARD_STOP_LOSS` and an already-elapsed 30-minute OOR timer on the same
tick closes for `HARD_STOP_LOSS`, and `oorStartedAt` is confirmed
unchanged afterward, at both the pure-decision level
(`resolveExitDecision.test.ts`) and the full-pipeline level with real
on-chain-shaped PNL/range math (`runExitCycle.test.ts`).

**PNL Protection**, resolved via an explicit question during review rather
than assumed: once PNL ever reaches -8%, `pnlProtectionActivatedAt` is set
once (sticky -- never cleared by recovery) and Trailing TP's arm threshold
permanently drops from +5% to 0%, using the exact same peak/drawdown/
15s-confirm mechanism as normal Trailing TP, **deliberately with no clamp**
on the drawdown line -- meaning PNL can legitimately dip to -2% before the
confirm timer even starts, and a position that recovers to breakeven then
immediately re-drops can close at a small loss rather than being
guaranteed to lock in breakeven.

**This was pushed back on twice** -- once resolved by picking an option in
review, then explicitly re-opened with "this genuinely needs a conscious
decision from you, not a default that happened to work." Re-examined
properly rather than re-citing the earlier answer:

The case for a HARD guarantee (close the instant PNL touches >=0% once
Protection is active, no drawdown/confirm at all in this mode) is real:
the entire point of naming this mechanism "Protection" is presumably to
stop the exact bad outcome the review raised -- recovering from a bad
drawdown only to lose money again. A soft-tolerance implementation that
permits exactly that outcome is arguably not "protecting" anything beyond
what a plain lower-threshold Trailing TP would already do.

**Decision: keep the soft-tolerance mechanism (no hard guarantee), for
three reasons, not just "the spec said so":**

1. The locked spec text is not silent here -- it explicitly says "bukan
   exit langsung, cuma mengubah parameter Trailing TP secara efektif"
   ("not an immediate exit, just effectively changes the Trailing TP
   parameter"). That sentence directly anticipates and rules out the hard
   variant. This isn't a gap being filled with judgment; it's explicit
   text being followed.
2. The risk is bounded and non-preferential: -2% is the exact same
   drawdown tolerance every other Trailing-TP-driven exit in this system
   already accepts. Giving PNL Protection a stricter (zero-tolerance) rule
   than every other profit-taking exit would be an unexplained special
   case, not a consistency improvement.
3. A hard instant-close-at-breakeven rule has its own real downside: it
   fires on a single tick's noise the moment PNL crosses 0%, forfeiting
   any further recovery even if the very next tick continues upward --
   trading a small, bounded, already-accepted risk for a different,
   unbounded one (permanently capping upside the moment breakeven is
   merely touched).

If real monitoring later shows the recover-then-redip pattern happening
often enough to matter, that is a targeted, well-scoped follow-up (e.g. a
config-tunable floor) -- not something to speculatively build now against
a risk that hasn't been observed. Documented here specifically so this
reads as a considered, owned engineering decision if it's ever revisited,
not an accident of implementation order.

### Persistent state (survives a restart mid-countdown)

New `ExitState` Prisma model (`prisma/schema.prisma`), one row per
position, standalone-keyed like `TokenCooldown`: Trailing TP's peak +
drawdown-confirm timer, OOR's grace timer, PNL Protection's sticky
activation flag, Safety Exit's metrics-failure-streak timestamp, the swap
retry counter, and the swap verification baseline (see below) -- all
persisted, none in an in-memory variable. `resolveExitDecision` itself
stays a pure function (no I/O, same discipline as
`decideCapitalAllocation`); restart-survival is entirely "the caller reads
`ExitState` from real storage before calling it, writes back whatever it
returns." Proven with a restart simulation, not just asserted: a timer
started 10 seconds before a fresh `ExitState` is seeded into a **brand
new** repository instance (as if freshly read back from storage after a
process restart, sharing no in-memory state with the original) still
correctly closes exactly 15 seconds after its ORIGINAL timestamp, not
15 seconds after the restart (`exitStateRepository.test.ts`, confirmed
again against real SQLite in `exitStateRepository.integration.test.ts`).

### Safety Exit -- concrete conditions, not an empty category

Flagged explicitly in review: a trigger category that never actually
fires is worse than no category at all. Two conditions, both with tests
that actually trigger them:

- **Sustained monitoring-read failure**: `PositionMetricsResult.ok ===
  false` for a position, continuously, for longer than
  `EXITS.SAFETY_EXIT.MAX_METRICS_FAILURE_MS` (5 minutes) -- tracked via
  `ExitState.metricsFailureSince`, restart-safe for the same reason as the
  timers above.
- **Structurally invalid pool price read**: `sqrtPriceX96 <= 0` or
  `tickCurrent` outside `TickMath`'s valid range -- an on-chain read that
  cannot be trusted for any PNL math, triggers with no timer at all.

A repeatedly-failing exit swap needed its own, separate detection
mechanism (raised explicitly in review): Module 6's own stuck-attempt
detection (`stuckAttempt.ts`) is keyed off ONE `TransactionAttempt` row's
`attemptCount`, but every swap retry here deliberately gets a **fresh**
idempotency key (see above) specifically so it's never cached as
permanently `FAILED` -- meaning no single row's `attemptCount` ever climbs
high enough to flag it, even after dozens of real retries spread across
dozens of distinct rows. `ExitState.swapAttemptCount` tracks this
independently, position-scoped; `isSwapRetryStuck` (threshold: 5,
matching `EXECUTION.STUCK_ATTEMPT_MAX_RETRIES`) and
`ExitStateRepository.findStuckSwapRetries` make it queryable -- not wired
to any live alerting yet (Module 9), and deliberately never feeds back
into the retry decision itself (a stuck swap means "someone should be able
to see this," not "stop retrying" -- the capital is real, at-risk TOKEN
sitting unswapped).

### On-chain verification before CLOSED

Per the locked flow order (Remove Liquidity -> Collect Fees -> Determine
Token Balance -> Quote -> Swap -> Verify USDG On-chain -> Position
CLOSED), a position is never marked `CLOSED` before the swap's on-chain
effect is actually confirmed. The verification baseline (USDG balance
immediately before the swap attempt's transaction was built) is persisted
to `ExitState` (`swapUsdgBalanceBeforeRaw`/`swapMinOutputAmountRaw`,
BigInt-as-decimal-string, same overflow reasoning as `Position.entryUsdgRaw`)
precisely so a `verifyOnChain` call in a different process after a restart
still has the correct "before" figure rather than re-reading a balance
that may already reflect the swap's own effect -- proven with the same
restart-simulation technique used for the timers above
(`swapTx.test.ts`). Verification requires a genuinely positive increase
(`> 0`, not just `>= 0`) even when `EXITS.MIN_RECEIVED_PROTECTION_ENABLED`
is off, so a swap with zero real effect still fails verification rather
than trivially passing a naive `>=` check.

Exit price impact is always computed and logged, regardless of
`EXITS.IMPACT_CHECK_ENABLED` (default off, per spec) -- that flag only
controls whether it's allowed to *defer* the swap (thrown from
`buildTransaction`, which `executeCriticalTransaction`'s catch-all treats
as ambiguous/resumable, retried later once conditions may have improved --
never a definitive failure, since price impact isn't evidence the
transaction itself is invalid).

### Testing

11 new test files under `exits/`/`swap/` (plus `positions/`'s existing
integration test extended, not counted as new), 135 net new tests (386 total
project-wide, up from 251 pre-Module-8): boundary-value tests for every
threshold (`-15%`, `-8%`, `+5%`, the `2%` drawdown line, `15s`/`30min`
timers, all tested at, just-below, and just-past each boundary); the
priority tests described above; the persistent-state restart simulations;
the full failed-exit state machine proof (all branches, including the
conditional approve leg, plus the stuck-forever counter-proof); Safety
Exit's two conditions actually firing; the routing-restriction and
Permit2-opt-out suites from the follow-up review; the swap module's
structural-validation and response-mapping tests; and `positions/`'s two
new repository methods (`findAllClosing`, `markExitFailed`) covered at
both the in-memory and real-Prisma-integration level. Full
typecheck/build/test suite clean, plus two real-Prisma smoke scripts --
one covering both failed-exit branches end-to-end against actual SQLite,
a second added in the follow-up review covering the approve leg
specifically (insufficient allowance -> approve -> verify -> swap ->
`CLOSED`).

### Scope note

Like Revision 7's `markFailed`, this module ships the *capability* to run
the exit flow correctly -- it does not yet wire `runExitCycle` into a live
15-second scheduler (`monitoring/monitorPositions.ts`'s `onMetrics`
callback or equivalent), because no composition root exists yet anywhere
in this codebase (every module so far stops at "expose the pieces +
tests," matching the established pattern -- live wiring is Module 9's
job). `swap/tradingApiClient.ts`'s exact endpoint/JSON shape also needs
verification against the real Uniswap Trading API before this is trusted
with real funds -- flagged, not silently assumed correct.

## Module 9A — positions/openPosition.ts

The last never-built piece of the position lifecycle: opening one. The
user's own framing before this started: don't jump to the composition
root (9B) until this is done and tested to the same standard as every
prior module -- this section is 9A alone; 9B is next, separately.

### One transaction, not two -- and why that changes the failure state machine

Unlike `exits/`'s two-transaction flow, opening a position needs no swap
up front: the USDG-only one-sided deposit strategy means the decided
position size (`decideCapitalAllocation`'s `positionSizeUsdgRaw`) is
already the exact currency being deposited. So the mandatory leg is a
SINGLE mint transaction, plus a CONDITIONAL USDG `approve()` for the
PositionManager (mirroring `exits/approveTx.ts`'s pattern, but
deliberately NOT sharing code with it -- see below).

**This makes the failure state machine genuinely simpler than exits/'s,
not just superficially so**: since nothing irreversible happens until the
mint itself is verified, a DEFINITIVE failure in EITHER leg (approve or
mint) gets the exact same response -- `positions.markFailed(id)`, full
stop. No fresh-idempotency-key retry pattern: retrying the same mint
would be actively wrong (the pool price has moved since the candidate was
decided, and the candidate itself may no longer be worth opening) -- the
correct "retry" is the next 30-minute screening cycle evaluating fresh
candidates against fresh prices, not this module re-attempting stale
parameters. An AMBIGUOUS (`resumable: true`) failure in either leg simply
leaves the position at OPENING, retried with the SAME idempotencyKey --
ordinary Module 6 resumability, nothing extra needed, since (unlike
exits/'s swap-after-verified-remove-liquidity case) there is no
already-completed earlier leg here that a retry could risk duplicating.

`positions/approveTx.ts` deliberately duplicates (rather than imports)
`exits/approveTx.ts`'s small `TxSafetyDeps`-builder shape: `positions/`
and `exits/` each own their tx-builders (matching this project's
established per-module convention), and `exits/` already depends on
`positions/` for `PositionRepository` -- importing the other direction
would create a circular module dependency.

### Verifying `V4PositionManager.addCallParameters` from source, not memory

Same discipline as Module 8's `removeCallParameters` verification: read
`node_modules/@uniswap/v4-sdk`'s actual source rather than assume a
method name/shape. Confirmed: presence of a `recipient` key (not
`tokenId`) is what `isMint()` uses internally to select the
`MINT_POSITION` action; `createPool`/`sqrtPriceX96` are correctly omitted
(`pools/selectPool.ts` only ever returns pools that already exist and are
already initialized, so a mint here never needs to initialize one);
`hookData` is omitted too, falling through to the SDK's own `EMPTY_BYTES`
default -- no pool selected so far has been observed needing
hook-specific mint calldata, flagged as a real gap if that ever changes.
`slippageTolerance` is 100% (no `amount0Min`/`amount1Min` floor),
consistent with the same judgment call already made for
`removeCallParameters` in Module 8.

A new position's liquidity isn't known in advance the way an existing
position's is for remove-liquidity -- `mintTx.ts` derives it from the
decided USDG amount via the v4 SDK's `Position.fromAmount0`/`fromAmount1`
(single-sided, same derivation already used by Module 7/8's own test
fixtures), reading a FRESH live pool price at build time, same as
`exits/removeLiquidityTx.ts` -- the stored `entryTick`/`entrySqrtPriceX96`
remain the decision-time snapshot (the PNL basis, unchanged), which can
legitimately differ from the price actually used to build the mint if it
moved between decision and execution.

### The `verifyOnChain` signature had to change -- a real, necessary Module 6 interface fix

A mint's tokenId isn't known until the PositionManager itself assigns it
during minting -- unlike remove-liquidity/swap, which verify against
ALREADY-KNOWN state, a mint's very identity is only discoverable from its
own transaction receipt (the ERC721 `Transfer(from=0x0, to=recipient,
tokenId)` log it emits). Reading a "next tokenId" counter beforehand and
assuming the mint uses exactly that value would be a real race condition
on a permissionless, shared contract other users can mint from
concurrently -- not a safe shortcut.

`TxSafetyDeps.verifyOnChain` (`execution/types.ts`) took zero parameters,
with no way to access the transaction's own hash for log-decoding.
Fixed by adding one parameter: `verifyOnChain(confirmedTxHash)`. Verified
**fully backward compatible** before relying on it: a function accepting
fewer parameters than its declared type is valid JS/TS, so every existing
implementation (`exits/removeLiquidityTx.ts`, `exits/swapTx.ts`,
`exits/approveTx.ts`) needed zero code changes -- confirmed by running
the complete pre-existing test suite (386 tests) unchanged immediately
after the interface edit, before writing anything new against it.
`blockchain/erc721.ts` (new) decodes the log via viem's `parseEventLogs`,
throwing a dedicated `MintedTokenIdNotFoundError` if no matching mint
event is found rather than guessing.

### A real, pre-existing configuration gap this surfaced

`UNISWAP_V4_POSITION_MANAGER_ADDRESS` (unlike `UNISWAP_V4_POOL_MANAGER_ADDRESS`
and `UNISWAP_V4_STATE_VIEW_ADDRESS`) has never had a confirmed real
default -- it defaults to `''` in `config/env.ts`. This was already being
read by `exits/removeLiquidityTx.ts` in Module 8, but no test ever
exercised that code path directly (Module 8's own tests only ever inject
a fully-faked `buildRemoveLiquidityDeps`, never the real implementation) --
so the gap stayed latent. `positions/approveTx.ts`'s test was the first
to actually invoke a real tx-builder reading this value directly,
surfacing it immediately as a hard failure (`encodeFunctionData` rejecting
an empty address). Fixed for testing via a fixture value in
`tests/setup.ts`; **the real value still needs to be sourced and
confirmed before this module is ever pointed at real funds** -- flagged
explicitly here rather than silently worked around only in test fixtures.

### Testing

4 new test files, 33 new tests (410 total, up from 393 mid-Module-9A --
393 already included the `verifyOnChain` signature-change verification
pass): `positions/approveTx.test.ts` (calldata shape, allowance
boundary checks); `positions/mintTx.test.ts` (fresh-price-per-call,
tokenId discovery + liquidity verification, failure-to-discover handling);
`positions/openPosition.test.ts` (the full state machine -- definitive
mint failure -> `markFailed` -> capital snapshot proven correct ->
`ActivePositionChecker` proven to allow re-screening, mirroring Revision
8's exact proof pattern; definitive approve failure -> same simple
response; ambiguous failures in either leg -> stays OPENING, same key;
**crash-resume simulation** -- SIGNED but never broadcast, then
`resumeOpenPosition` called on the same row, proven via a spy that
`signTransaction` is never invoked a second time; a mint that reaches
CONFIRMED but fails `verifyOnChain` proven to never reach ACTIVE); plus
`findAllOpening()` covered at both the in-memory and
real-Prisma-integration level (`positions/positionRepository.integration.test.ts`).
Full typecheck/build/test suite clean, plus a real-Prisma smoke script
covering both the definitive-failure and ambiguous-failure-then-resume
scenarios end-to-end against actual SQLite.

### Scope note

Ships the capability to open a position correctly -- deliberately stops
short of wiring it into a live 30-minute screening cycle, matching every
prior module's "expose the pieces + tests, wire it in the composition
root" pattern. That wiring, together with the 15-second monitoring and
exit cycles running concurrently, re-entrancy guards, startup resume, and
graceful shutdown, is Module 9B -- next, and explicitly gated on this
section being reviewed first.

## Module 9B — composition root

The bot is now a real running process. Every module built through 9A
stopped deliberately short of live wiring ("expose the pieces + tests");
this is the module that actually starts them. `src/index.ts` is now a
thin process-level entrypoint (construct real deps, start the app, wire
OS signals); all real logic lives in `src/composition/` so it can be
exercised directly by tests without spawning a process.

### Three independent cycles, not a pipeline

```
30-min screening: discovery -> filter -> capital check -> pool select
                   -> range calc -> open (Module 9A)
15-sec monitoring: Module 7's runMonitoringCycle, unmodified
15-sec exit:       Module 8's runExitCycle (ACTIVE decide pass + CLOSING
                    resume pass, both already internal to it) + a NEW,
                    separate OPENING resume pass (Module 9A) -- "dua
                    resume pass, bukan satu," per explicit review
```

Monitoring and exit are deliberately two SEPARATE 15-second schedules,
not one feeding the other's output -- `exits/runExitCycle.ts` already
re-reads live position state itself (built that way in Module 8), so
there was never a reason to make monitoring's output a dependency of
exit's decision, and keeping them independent means a slow/failing
monitoring tick can never stall exit evaluation or vice versa (proven,
not just argued -- see Testing below).

`discovery/scheduler.ts`'s `scheduleInterval` (Module 2's re-entrancy
guard) is reused completely as-is for all three schedules -- explicitly
NOT rebuilt, per review ("`discoveryService.ts`/`scheduler.ts` dari
Module 2 sudah punya pola ini -- reuse, jangan bikin ulang"). Its guard
only prevents the SAME cycle from overlapping itself, though -- it has no
way to tell an external caller "wait for the in-flight run to finish,"
which graceful shutdown needs. Rather than modify `scheduler.ts` to add
that, `composition/app.ts` wraps each cycle in a small `trackable()`
helper that layers its own "is a run currently in flight" tracking on
top, purely additively.

### `PoolPriceProvider` had no real implementation anywhere -- confirmed, not assumed

A full-repo search before wiring anything confirmed `monitoring/types.ts`'s
`PoolPriceProvider` port (needed by monitoring, exits, and
`positions/openPosition.ts`) had zero implementations, real or stubbed,
anywhere in the codebase -- every other port needed for the 30-min cycle
(`PoolDiscoveryPort`, `PoolStateProviderPort`, `PoolVolumeProviderPort`)
already had a real, on-chain, previously-tested implementation from
Module 3. `pools/poolPriceProvider.ts`'s `StateViewPoolPriceProvider` is
the fix -- a pure reshape adapter over Module 3's already-real
`StateViewPoolStateProvider` (different shape on both ends: `V4PoolRef`
vs. the flat `PositionPoolContext` actually stored on a `PositionRecord`,
and a full `V4PoolStateSnapshot` vs. the narrower `{sqrtPriceX96,
tickCurrent}` the port wants), not new on-chain logic.

### Startup resume and graceful shutdown, without extra code paths

"Run every resume pass immediately at startup, don't wait for the first
tick" turned out to need no special-cased startup logic at all:
`scheduleInterval`'s existing `runImmediately: true` option, applied to
the exit+open-resume cycle like every other schedule, makes that cycle's
very first invocation happen immediately -- and since the CLOSING and
OPENING resume passes are simply part of what that cycle function always
does, they run on the first tick for free.

Graceful shutdown (`SIGTERM`/`SIGINT`): `stop()` halts all three
schedules, then waits (via each cycle's `trackable().waitForIdle()`) for
any currently-in-flight run to actually finish -- proven with a
deliberately slow fake cycle whose completion flag is only set AFTER
`stop()` is called, confirming `stop()` genuinely blocked until it
finished, not just until the schedule was cancelled. A configurable
timeout (`shutdownTimeoutMs`) prevents a genuinely hung cycle from
blocking shutdown forever -- also proven, with a slow "hung" fake cycle
and a short timeout, confirming `stop()` returns promptly rather than
waiting for the full hang. **The exact timeout-cancellation semantics
and the production default were tightened in a follow-up review round
-- see [Revision 9](#revision-9--module-9b-follow-up-shutdown-semantics-every-tick-proof-real-positionmanager-address)
below; this paragraph describes the mechanism, that section describes
what the timeout does and does not do.**

### `recordExit` was built in Module 5, never called by anything -- until now

`cooldown/cooldownRepository.ts`'s `PrismaCooldownRepository.recordExit`
has existed since Module 5. A full-repo grep before wiring anything
confirmed it: neither `exits/executeExit.ts` nor `exits/runExitCycle.ts`
has a cooldown field at all, and `recordExit` had exactly one match in
the whole codebase -- its own definition. The composition root
(`exitCycle.ts`) is the first and only place it's ever invoked: for every
position `runExitCycle` reports `CLOSED` this tick, its token address is
looked up (the row still exists -- CLOSED is terminal, never deleted) and
`recordExit` is called, completing the per-token cooldown loop that was a
documented but unwired gap until this commit.

### Minimal structured logging, per explicit requirement

`composition/logger.ts`: one JSON line per event, to console and a
`logs/lunex-bot.log` file, deliberately simple (no rotation, no external
service) -- explicit review requirement, since Telegram/UI (and Alert
Push, always fully on-demand even once built) don't exist yet, this is
the only visibility into the bot's behavior during the manual testing
period. Every cycle logs a summary (candidates evaluated/passed/deployed
for screening; positions monitored/ok/failed for monitoring; closed
count/open-resume attempts for exit). Module 6's `findNonTerminal()` and
Module 8's `findStuckSwapRetries()` are queried every exit-cycle tick and
surfaced as `warn`-level log lines whenever non-empty -- explicitly
requested so a stuck attempt or a stuck swap-retry loop is visible in the
logs immediately, not silently invisible until Module 9's later
Telegram/UI/`/status` work exists.

### Testing

4 new test files, 24 new tests (434 total, up from 410 mid-Module-9B):
`screeningCycle.test.ts` (hard-filter short-circuit, capital/pool/range/open
skip-and-continue per `TRY_NEXT_CANDIDATE_ON_FAILURE`, the
`MAX_SUCCESSFUL_DEPLOYMENTS_PER_CYCLE` cap proven to count both `ACTIVE`
and ambiguous `PENDING` outcomes -- deliberately, since an OPENING
position's capital is already reserved regardless of final mint outcome);
`exitCycle.test.ts` (cooldown recording, the second OPENING resume pass
running independently of the exit decide/resume passes, stuck-attempt/
stuck-swap-retry surfacing with and without anything actually stuck);
`app.test.ts` (re-entrancy proven with a cycle deliberately slower than
its own schedule interval, the three cycles proven independent via a slow
screening cycle that never blocks monitoring/exit ticks, both halves of
graceful shutdown as described above); and
**`integration.test.ts`** -- the smoke test explicitly requested in
review, running the REAL `startApp` (unmodified) for several short cycles
with fast intervals against mocked RPC/contracts (the same tx-builder-seam
fakes every other smoke test in this project already uses, plus the REAL
`PositionCapitalSnapshotProvider` operating on a fake in-memory
repository, not a hardcoded fixed snapshot), proving: a position opened
by screening is observed by monitoring and closed by exit via a real
simulated price crash, all three schedules genuinely ticking multiple
times independently within one run; a stuck (perpetually ambiguous) mint
never blocks monitoring/exit from continuing to tick for the rest of the
system; a definitively-failed mint's capital is confirmed released via a
fresh capital-snapshot read taken mid-run, in the same live process --
not a separately-reasoned assertion. Full typecheck/build/full-suite
clean, plus a real-Prisma smoke script proving `createRealAppDeps()`
(the actual production wiring, every real repository/adapter constructor)
and `startApp`/`stop()` succeed against a real Prisma-backed SQLite DB --
confirmed the screening cycle's `gmgn-cli`-not-installed failure is caught
by `scheduleInterval`'s `onError` and logged, never crashing the process.

### Scope note

`api/`/`auth/`/`telegram/`/`ui/` remain unbuilt -- this module makes the
bot runnable end-to-end from the command line (`npm start`), with
structured log output as the only window into its behavior, exactly as
scoped. `swap/tradingApiClient.ts`'s endpoint/JSON shape (Module 8) and
`UNISWAP_V4_POSITION_MANAGER_ADDRESS` (Module 9A) both still need
verification against real services/values before any of this touches
real funds -- both already flagged in their own sections above, restated
here since the composition root is what would actually exercise them
live.

## Revision 9 — Module 9B follow-up: shutdown semantics, every-tick proof, real PositionManager address

Three points raised in review of Module 9B, each requiring either a
precise semantic answer backed by code/tests, or a concrete fix. 441
tests total, up from 434 (7 new: 4 in `app.test.ts` -- 1 replaced,
3 new -- 1 in `integration.test.ts`, 3 in `positionManagerBinding.test.ts`,
1 in `mintTx.test.ts`).

### 1. Graceful shutdown timeout: what it does and does NOT cancel

There is no `AbortController` anywhere in this pipeline -- not in
`executeCriticalTransaction`, not in any Prisma call, not in any RPC
call. That means `composition/app.ts`'s `stop()` timeout can only ever
stop the CALLER from waiting; it has no mechanism to reach into an
in-flight cycle and cancel it. Confirmed with a dedicated test (not just
argued): `app.test.ts`'s `'CRITICAL: a timeout does NOT cancel the
in-flight work'` runs a fake cycle that takes 150ms against a 50ms
`shutdownTimeoutMs` -- `stop()` returns `{timedOut: true}` at ~50ms with
the cycle's own completion flag still `false`, then, with no further
calls made, the same flag flips to `true` on its own ~150ms after the
cycle started -- proving the abandoned work kept running in the
background, unaffected by `stop()` having already returned.

This makes `stop()`'s return value load-bearing, not informational:
`stop()` now returns `{ timedOut: boolean }` (previously `void`), and
**a real bug was found and fixed as a direct result**: `src/index.ts`
previously called `process.exit(0)` unconditionally right after
`await stop()`, with no regard for whether a cycle was still writing to
the database in the background. `shutdown()` now checks `timedOut` and,
when true, deliberately does NOT call `process.exit()` -- it logs a
`shutdown_timed_out` warning and returns, letting Node's event loop keep
the process alive on its own for exactly as long as the abandoned
work (and anything it's still waiting on) genuinely takes, so the
process only ever exits once nothing is left in flight. `disconnectPrismaClient()`
(new, `storage/prismaClient.ts`) is only ever called on the non-timed-out
path, for the same reason.

The production timeout is no longer the 30-second test-sized value from
the first draft -- it's a new `SHUTDOWN_TIMEOUT_MS` env var
(`config.composition.shutdownTimeoutMs`), defaulting to 10 minutes,
sized (per its doc comment in `config/env.ts`) to comfortably exceed any
single critical step (a tx wait-for-receipt, a handful of RPC calls, a
full mint) -- deliberately NOT sized to the 30-minute screening
*schedule* interval, since "how often a cycle starts" and "how long one
instance normally takes" are different numbers and conflating them would
be wrong. Tunable per deployment.

### 2. All three exit-cycle sub-passes re-run on every tick, not just at startup

`composition/exitCycle.ts`'s `runExitAndOpenResumeCycle` -- the ACTIVE
decide pass + CLOSING resume pass (both via Module 8's `runExitCycle`),
the cooldown recording loop, and the OPENING resume pass (`findAllOpening`
+ `resumeOpenPosition`) -- is a single function body, and that entire
function is the `task` callback passed to `scheduleInterval`. There is
no separate "startup-only" code path; `runImmediately: true` just means
the first invocation of that same callback happens immediately instead
of waiting for the first interval tick. By construction, every regular
tick after that runs the identical body, including both resume passes.

Proven directly, not just by reading the code: `integration.test.ts`'s
new `'CRITICAL: all three exit-cycle sub-passes ... re-run on EVERY
tick'` test starts the app, lets the exit cycle tick once (its
`runImmediately` startup tick, with nothing to resume), and only THEN
creates a position already in `OPENING` status -- deliberately after
startup, with no restart and no new `startApp()` call, simulating a
position that entered `OPENING` mid-run rather than one recovered after
a crash. It then lets several more regular ticks elapse and confirms
via two independent signals: the position's status left `OPENING`
without any restart, and the `exit_cycle` log events show
`openResumeAttempts > 0` on a tick that is strictly later than the
position's creation. If the OPENING resume pass only ran once at
process start (the failure mode this test rules out), this position
would never have been picked up short of a full restart.

### 3. Real `UNISWAP_V4_POSITION_MANAGER_ADDRESS` + a confirmed self-check

Added to `config/env.ts` with the same
`.regex(/^0x[0-9a-fA-F]{40}$/)` validation as the two existing v4
addresses, defaulting to the confirmed value:
`0x58daec3116aae6d93017baaea7749052e8a04fa7`.

Whether a `StateView.poolManager()`-style self-check was even possible
for `PositionManager` was checked directly against the real, installed
`@uniswap/v4-sdk` package (its `positionManagerAbi` export), not
assumed either way -- and it turned out `poolManager()` exists there
too: a zero-arg view function returning the single `PoolManager` that
`PositionManager` instance is bound to, the exact same shape of
self-check `StateView` already gets. `positions/positionManagerBinding.ts`
(`checkPositionManagerBinding` / `ensurePositionManagerBinding`) mirrors
`pools/poolStateProvider.ts`'s existing `StateView` binding-check pattern
exactly -- a pure comparison function plus a memoized-once-per-process
async wrapper -- and is wired into `mintTx.ts`'s `buildTransaction` as
its first step, before any live price is read. A config mismatch
between `UNISWAP_V4_POSITION_MANAGER_ADDRESS` and
`UNISWAP_V4_POOL_MANAGER_ADDRESS` is now caught at first real use
instead of silently building calldata against the wrong contract.

### Verification

Full `npx tsc --noEmit`, full `npx tsc -p tsconfig.build.json` build
(clean, `dist/` removed after), full `npx vitest run` -- 441/441
passing. A real-Prisma smoke script (throwaway `.env` with the real
`UNISWAP_V4_POSITION_MANAGER_ADDRESS` and a short test
`SHUTDOWN_TIMEOUT_MS`) confirmed against a real SQLite DB: the env var
and config wiring read correctly; `checkPositionManagerBinding` passes
on a matching pair and throws referencing
`UNISWAP_V4_POSITION_MANAGER_ADDRESS` by name on a mismatched one;
`stop()` returns `{timedOut: false}` once the (real, sandbox-absent)
`gmgn-cli` retry/backoff sequence had genuinely finished; and
`disconnectPrismaClient()` succeeded cleanly. All smoke-test artifacts
(`.env`, `dist/`, `logs/`, temp DB files) removed afterward.

## Module 10 — `api/` + `auth/`

The single HTTP backend Telegram and UI will both consume later as
separate clients -- neither is built here. `AUTH_ADMIN_USERNAME`/
`AUTH_ADMIN_PASSWORD_HASH`/`JWT_SECRET`/`API_PORT` etc. have existed in
`config/env.ts` since Module 1, unused until now. Two decisions were
locked *before* any endpoint was written, per explicit review requirement:

### 1. Pause means "no new deployments," never "stop managing what's open"

Enforced as a single check at the very top of `runScreeningCycle`
([screeningCycle.ts](src/composition/screeningCycle.ts)): if paused, the
**entire** cycle body is skipped -- not even
`discoveryService.discoverTopCandidates()` runs, so a paused bot makes no
GMGN CLI calls at all. `ScreeningCycleSummary` gained a `paused: boolean`
field so a paused-skip is distinguishable in logs/`GET /status` from "ran,
found zero candidates." Deliberately NOT a guard around the scheduler in
`composition/app.ts` -- `runMonitoringLoggingCycle` and
`runExitAndOpenResumeCycle` have no pause check anywhere in them, proven
(not just left unwritten) by a dual test in `exitCycle.test.ts`: pause the
bot, seed an ACTIVE position, confirm monitoring still reports it AND the
exit cycle still evaluates/closes it normally, entirely while paused.

### 2. Four parameters move to a live `Settings` table; everything else stays frozen

| Field | Replaces | API boundary | Stored as |
|---|---|---|---|
| `positionSizePct` | `CAPITAL.POSITION_SIZE_PCT_OF_FREE_BALANCE` | percent, `0 < x <= 100` | fraction |
| `maxActivePositions` | `CAPITAL.MAX_ACTIVE_POSITIONS` | integer, `1-50` | int |
| `hardStopLossPct` | `EXITS.HARD_STOP_LOSS_PCT` | percent, `-100 <= x < 0` | fraction |
| `trailingTpTriggerPct` | `EXITS.TRAILING_TP.TRIGGER_PEAK_PNL_PCT` | percent, `0 < x <= 1000` | fraction |

Plus `paused: boolean`, changeable ONLY via `POST /control/pause`/`resume`
-- `PATCH /settings`'s schema doesn't even recognize `paused` as a field
(rejected as unrecognized, per `.strict()`), so a bug in one control
surface can never accidentally flip the other.

**Timer/window durations stay frozen** (`TRAILING_TP.DRAWDOWN_FROM_PEAK_PCT`/`CONFIRM_WINDOW_MS`,
`OOR.GRACE_WINDOW_MS`, `PNL_PROTECTION.*`, `SAFETY_EXIT.MAX_METRICS_FAILURE_MS`,
`SWAP_RETRY.STUCK_THRESHOLD`), restart-only, even though structurally
similar to the four above: a plain threshold is stateless (compared fresh
every tick), but a window value is compared against an ALREADY-RUNNING
persisted timestamp in `ExitState` -- changing it mid-countdown has a
history-dependent effect a stateless threshold change doesn't. Also kept
frozen: `MAX_TOTAL_DEPLOYED_PCT_OF_PORTFOLIO` and everything not named as
a candidate (addresses, RPC, secrets, discovery/filter/pool-selection
params, cycle intervals) -- kept tight to the three parameters actually
requested (position size %, TP/SL threshold, max active positions).

**Purity preserved, not broken**: `decideCapitalAllocation` and
`resolveExitDecision` used to read `config.rules.*` internally. Both now
take the rules object as an explicit, REQUIRED parameter instead (no
default -- every call site must say where its rules come from), same
pattern `checkEthGasReserve` already used. `screeningCycle.ts` and
`exits/runExitCycle.ts` are the only two places that merge live settings
over frozen config -- each reads `settings.get()` exactly ONCE per cycle
invocation (not once per candidate/position) and reuses that single
snapshot for everything evaluated that tick.

### Two cross-field safety interactions, added after plan review

**PNL Protection's arm-threshold source must switch correctly, never one
value unconditionally.** `resolveExitDecision.ts`'s existing branch
(`pnlProtectionActivatedAt !== null ? rules.PNL_PROTECTION.NEW_TP_TARGET_PCT : rules.TRAILING_TP.TRIGGER_PEAK_PNL_PCT`)
is correct by construction as long as `runExitCycle.ts` only ever
overrides `TRAILING_TP.TRIGGER_PEAK_PNL_PCT`/`HARD_STOP_LOSS_PCT` with
live values and leaves `PNL_PROTECTION.*` untouched (always frozen). Not
assumed safe from reading the branch once -- proved with a **two-directional**
test pair in `resolveExitDecision.test.ts`: (a) PNL Protection inactive +
`trailingTpTriggerPct` changed live → the new value actually arms Trailing
TP; (b) PNL Protection ALREADY active + `trailingTpTriggerPct` changed
live to three different values → arm threshold stays the frozen 0% every
time, the live setting completely ignored. (b) is the one that actually
matters and is written explicitly, not inferred from (a) passing -- same
two-directional discipline as the CLOSING/OPENING proofs in earlier
revisions.

**`PATCH /settings` can never let `hardStopLossPct` defeat PNL Protection.**
Rule (`settings/validateSettingsPatch.ts`, pure function, runs BEFORE the
repository is ever touched): `hardStopLossPct <= EXITS.PNL_PROTECTION.TRIGGER_PNL_PCT`
(-8%) -- i.e. equal or more negative. `-15%` accepted (worse than -8%,
PNL Protection still gets a chance to activate first); `-5%` rejected with
an explicit message (would make Hard Stop Loss always fire before PNL
Protection could ever activate); `-8%` exactly accepted (inclusive
boundary). Tested both at the unit level and through the real
`PATCH /settings` endpoint (rejection leaves the DB row untouched,
confirmed by re-reading it).

### Endpoints (all reuse existing functions/repositories)

`POST /auth/login` (unauthenticated, rate-limited) issues a JWT. Every
other endpoint requires `Authorization: Bearer <token>`
(`auth/authMiddleware.ts`, 401 on missing/invalid/expired):

- `GET /status` -- `CapitalSnapshotProvider` (Module 5) + per-status
  position counts (Modules 5/8/9A) + `settings.get()` for `paused`.
- `GET /positions` -- reuses `runMonitoringCycle` (Module 7) in full via
  its `onMetrics` callback, zipped with each position's persisted
  `ExitState.oorStartedAt` (Module 8) for OOR elapsed/remaining.
- `GET /positions/stuck` -- `findNonTerminal()` + `isStuckAttempt`
  (Module 6) and `findStuckSwapRetries` (Module 8), zero new detection
  logic.
- `GET /cooldowns` -- **one genuinely new primitive**:
  `PrismaCooldownRepository.findAllActive()` (nothing before this listed
  every token in cooldown, only checked one at a time), reusing the
  existing pure `computeCooldownStatus` for the remaining-time math per
  row.
- `GET /logs` -- last N lines of `logs/lunex-bot.log` (Module 9B),
  parsed as JSON, `limit` query param (default 100, max 1000). Missing
  file → empty array, not a 500.
- `POST /control/pause` / `POST /control/resume` -- the only way `paused`
  changes.
- `PATCH /settings` -- two validation layers (static per-field schema +
  the Decision-3b cross-field check above) before any DB write.

No health-check endpoint added -- none was concretely requested.

### `auth/`

`POST /auth/login` validates `{username, password}`, `bcrypt.compare`s
against `config.auth.adminPasswordHash`, signs a JWT
(`config.auth.jwtExpiry`, default 15m). No `/auth/refresh` endpoint --
only login was requested; `REFRESH_TOKEN_EXPIRY` stays present-but-unused,
flagged rather than silently built. Login is rate-limited
(`express-rate-limit`, `skipSuccessfulRequests: true` -- only FAILED
attempts count toward the window, matching "N kali gagal," not N attempts
total) and keyed by client IP, which only works correctly behind a
reverse proxy once `app.set('trust proxy', config.api.trustProxy)` is
wired (this commit) -- `API_TRUST_PROXY` existed since Module 1, unused
until now.

**HTTPS is never terminated in this Node process** -- `API_HTTPS_CERT_PATH`/
`API_HTTPS_KEY_PATH` (existing since Module 1) remain present-but-unused.
TLS termination is a reverse-proxy/deployment-layer responsibility;
running this API behind plain HTTP in production is a real risk that must
be closed at that layer, not in application code, per explicit
instruction not to build TLS termination unless asked.

### A real, pre-existing bug found via this module's own smoke test -- full audit

Wiring `app.set('trust proxy', config.api.trustProxy)` was the first thing
in this entire project to actually READ `config.api.trustProxy` at
runtime -- and doing so immediately crashed `express-rate-limit`
(`ERR_ERL_PERMISSIVE_TRUST_PROXY`) because `API_TRUST_PROXY=false` in
`.env.example` was being read as `true`. Root cause: `z.coerce.boolean()`
coerces via plain `Boolean(value)`, and `Boolean("false")` is `true` in
JavaScript -- ANY non-empty string coerces to `true`, so the literal env
string `"false"` was silently flipped ON. Fixed with a `booleanEnv(defaultValue)`
helper in `config/env.ts` that parses the literal strings `"true"`/`"false"`
explicitly (anything else fails validation) -- following review, this was
audited exhaustively rather than accepted as "four fields, fixed, move on."

**Full inventory, confirmed by grepping the entire `src/` tree for every
`z.coerce.boolean()`, every `z.boolean()`, every bare `Boolean(...)` call,
and every direct `process.env.X` boolean check outside `config/env.ts`**
(the audit's own methodology, not just re-checking the four already
found): there were, and are, **exactly four** env-sourced boolean fields
in the entire config layer. All four used the vulnerable pattern; all
four are now fixed via `booleanEnv`; nothing else in `src/` parses a
boolean from an env string by any other route. Every OTHER boolean-valued
field in `config/constants.ts` (`HONEYPOT_CHECK_INCLUDED`,
`ONE_POSITION_PER_TOKEN`, `TRY_NEXT_CANDIDATE_ON_FAILURE`,
`LOW_YIELD_EXIT_ENABLED`, `SAFETY_EXIT_ENABLED`,
`REQUIRE_ONCHAIN_VERIFICATION_BEFORE_STATE_UPDATE`, `RESUMABLE_ON_RESTART`,
`INTERFACES.*` including `IP_WHITELIST_ENABLED`/`HTTPS_REQUIRED`) is a
plain TypeScript literal (`true`/`false` written directly in source), never
parsed from a string at all -- categorically not exposed to this bug
class. `GMGN_ALLOW_AUTOMATED_TRADES` does not exist anywhere in this
codebase (checked) -- there is nothing to audit for it.

**Per-field detail -- intended value, `.env.example`'s literal string, and
the actual pre-fix runtime value:**

| Env var | Exposed as | Intended (locked) | `.env.example` literal | Pre-fix runtime value | Was this reachable by real logic? |
|---|---|---|---|---|---|
| `API_TRUST_PROXY` | `config.api.trustProxy` | `false` (only `true` behind a real reverse proxy) | `API_TRUST_PROXY=false` | **`true`** (bug) | Not read by ANY code before this module -- `app.set('trust proxy', ...)` in `api/server.ts` is the first and only consumer, added in this same commit. Its own dependency (`express-rate-limit`) refused to start rather than run with the misconfiguration -- caught immediately, not silently. |
| `ETH_GAS_RESERVE_ENABLED` | `config.rules.capital.ETH_GAS_RESERVE_ENABLED` | `false` (explicitly TBD/unlocked per spec, "do not invent a default") | `ETH_GAS_RESERVE_ENABLED=false` | **`true`** (bug) | Yes -- two call sites. See below: this is the one with a genuinely severe would-be consequence. |
| `EXIT_IMPACT_CHECK_ENABLED` | `config.rules.exits.IMPACT_CHECK_ENABLED` | `false` (locked OFF per spec) | `EXIT_IMPACT_CHECK_ENABLED=false` | **`true`** (bug) | Yes -- `exits/executeExit.ts`, live since Module 8. See below. |
| `EXIT_MIN_RECEIVED_PROTECTION_ENABLED` | `config.rules.exits.MIN_RECEIVED_PROTECTION_ENABLED` | `false` (locked OFF per spec) | `EXIT_MIN_RECEIVED_PROTECTION_ENABLED=false` | **`true`** (bug) | Yes -- `swap/tradingApiClient.ts`, live since Module 8. See below. |

**None of these were ever confirmed to run wrong in a real deployment** --
there is no evidence this project has ever been started against a real
`.env` file (every run in this project's history, including every prior
module's smoke test, used either an in-memory test fixture that never
sets these four keys, or a throwaway `.env` I constructed myself for that
smoke test). What follows is what WOULD have happened had anyone followed
the documented setup (`cp .env.example .env`) and actually run the bot at
any point since these fields' consumers went live -- this is a design-risk
finding about the codebase, not a confirmed production incident, and it's
reported that way deliberately rather than either overclaiming an incident
or quietly fixing it without flagging the exposure:

- **`ETH_GAS_RESERVE_ENABLED`, if actually `true`, would have paralyzed
  deployment entirely, loudly.** `capital/decideCapitalAllocation.ts`
  (called every screening cycle since Module 9B wired it) would receive
  `ETH_GAS_RESERVE_ENABLED=true` and call `checkEthGasReserve(snapshot.ethBalance, true, ...)`.
  `positions/capitalSnapshotProvider.ts`'s real `PositionCapitalSnapshotProvider`
  -- confirmed by reading it -- NEVER populates `ethBalance` on the
  snapshot it returns (the field doesn't appear in that file at all).
  `checkEthGasReserve` therefore hits its `ethBalance === undefined`
  branch and returns `{ok:false, reason:'ETH gas reserve check is enabled
  but no ETH balance was provided in the snapshot'}` -- for EVERY
  candidate, every cycle, forever. The bot would never deploy a single
  position. Loud, not silent (the exact reason string appears in the
  screening-cycle skip log every 30 minutes), but total. The OTHER call
  site (`execution/gasAffordability.ts`'s gas-check during real
  transaction execution, live since Module 6) would have been unaffected
  even with the flag flipped, because it always supplies a real
  `ethBalance` and `ETH_GAS_RESERVE_MIN` defaults to `0` (also unset in
  `.env.example`), making the reserve threshold `0` regardless of
  enabled/disabled.
- **`EXIT_IMPACT_CHECK_ENABLED`, if actually `true`, could have produced
  exits stuck forever, invisibly.** `exits/executeExit.ts` (live since
  Module 8) would block any exit swap whose price impact exceeds
  `PRICE_IMPACT.MAX_EXIT_IMPACT_PCT` (1%), returning `{outcome:'PENDING'}`
  and retrying next tick -- and critically, this specific branch returns
  BEFORE any `TransactionAttempt` is created, so `ExitState.swapAttemptCount`
  is never incremented. `findStuckSwapRetries` (Module 8's own stuck-exit
  detection, surfaced via `GET /positions/stuck` in this module) keys
  exclusively off `swapAttemptCount` -- so a position stuck in this exact
  loop would be invisible to the one mechanism built specifically to
  surface stuck exits. This is the most concerning of the four findings:
  not just "would have broken something loudly" but "would have broken
  something in a way this project's own safety net doesn't catch."
- **`EXIT_MIN_RECEIVED_PROTECTION_ENABLED`, if actually `true`, would have
  activated an explicitly-unfinished placeholder.** `swap/tradingApiClient.ts`
  (live since Module 8) would compute a non-zero `minOutputAmountRaw` via
  a function whose own doc comment says "1% here is a conservative
  starting point, not a spec value... only ever exercised when enabled"
  -- i.e. code that was written to exist but was never meant to actually
  run yet. A quote failing that minimum would be rejected by
  `validateSwapQuote`. Unlike the impact-check case, this failure DOES
  flow through the normal `TransactionAttempt`/`swapAttemptCount` machinery
  (so it would have been visible to stuck-detection) -- the concern here
  is spec deviation (an untested guard silently active) more than
  invisibility.

### Did this affect any existing test? Checked, not assumed

Grepped every test file for the four env var names: only
`tests/config.smoke.test.ts` references the resulting config values at
all (asserting `ETH_GAS_RESERVE_ENABLED`/`IMPACT_CHECK_ENABLED`/
`MIN_RECEIVED_PROTECTION_ENABLED` are `false`), and it does exercise the
real parsing path (imports `config`, not an injected value) -- but **no
test file anywhere ever sets these four env vars explicitly** (confirmed
by grep). `tests/setup.ts`'s fixture env never touches them either. Since
zod's `.default(value)` short-circuits entirely when the input key is
`undefined` (never even reaching the coercion logic), every prior test
run saw these fields as genuinely absent from `process.env`, took the
`.default(false)` fast path, and got the CORRECT value -- for a reason
that had nothing to do with correct string parsing. `tests/config.smoke.test.ts`
was passing "for the right output via a path that never actually
exercised the vulnerable code" -- confirmed directly, not inferred, by
temporarily reintroducing the old `z.coerce.boolean()` pattern for one
field and observing that the SUITE'S EXISTING tests still passed (they
never touch the field), while the NEW generic regression test (below)
immediately failed. This matches the project's dependency-injection
discipline generally protecting pure-function unit tests (`decideCapitalAllocation`/
`resolveExitDecision` take rules as explicit parameters in tests, never
reading `config` live) -- but this particular bug lived one layer below
that boundary, in the raw env-parsing step itself, which is exactly why
DI-based unit tests couldn't have caught it either way.

### Generic regression test -- covers future boolean fields automatically, not just these four

`tests/config/envBooleans.test.ts` does NOT hardcode the four field names
as its source of truth. It parses one minimal valid env object through
the real `envSchema` (newly exported from `env.ts` for this purpose),
discovers every field whose OUTPUT is `typeof value === 'boolean'`, and
then re-parses that same base object with each discovered field
overridden to `"false"`, `"true"`, and an invalid value (`"yes"`) in turn
-- asserting `false`/`true` respectively, and that the invalid value is
REJECTED (not silently coerced). A field added later for `telegram/`/`ui/`
is automatically covered the moment it exists in the schema; nobody has
to remember to add it here. Verified this test is not trivially green:
temporarily reintroduced `z.coerce.boolean().default(false)` for
`API_TRUST_PROXY` alone and confirmed the two new tests for that field
fail immediately (`"false"` parses to `true`; `"yes"` parses successfully
instead of being rejected) -- then restored the fix and reconfirmed all
tests pass.

### Testing

64 new tests (505 total, up from 441): `tests/settings/` (cross-field
validation, both directions and the exact boundary); Decision 3a's
two-directional pair and a new `hardStopLossPct` live-reload scenario
added to `tests/exits/`; pause-skip + live `positionSizePct`/
`maxActivePositions` reload added to `tests/composition/screeningCycle.test.ts`;
the dual pause-never-affects-monitoring/exit proof added to
`tests/composition/exitCycle.test.ts`; a full `tests/api/` suite (new
devDependency `supertest`) covering every route's response shape, 401 on
missing/invalid/expired/wrong-secret JWTs, and login rate-limiting
(lockout after N failures, reset after the window, successful logins
never counted); `tests/config/envBooleans.test.ts`'s generic boolean-field
audit (above). A real-Prisma smoke script exercised login with a real
bcrypt hash, JWT-gated access, `PATCH /settings` + Decision 3b rejection
against the real endpoint, `POST /control/pause`, and confirmed every
write persisted correctly in real SQLite -- `GET /status`'s own on-chain
capital read was intentionally left out of the smoke script (no real
Robinhood Chain RPC endpoint reachable from this sandbox; that route's
logic is already fully covered against fake RPC ports in
`tests/api/status.test.ts`), same category of flagged real-network
dependency as `swap/tradingApiClient.ts`. Full typecheck, full build,
full suite all clean; all smoke-test artifacts removed afterward.

### Scope note

`telegram/`/`ui/` remain unbuilt, as scoped -- both will be separate
clients of this same API. `swap/tradingApiClient.ts`'s endpoint/JSON
shape (Module 8) still needs verification against the real service before
any of this touches real funds.

## Module 11 — `telegram/`

The first real client of Module 10's API. `telegram/` talks to `api/`
ONLY over loopback HTTP (`http://localhost:API_PORT`) -- it never imports
`positions/`/`capital/`/`exits/`/etc. directly, even though both run in
the same Node process. This is what keeps "the API is the single source
of truth" true in practice, not just intent, and is the precedent `ui/`
will be held to next. `telegram/apiClient.ts` is the ONLY file in the
module that makes an HTTP call; every command handler goes through it.

Five decisions were locked before writing any command handler (four
requested, a fifth surfaced by research and confirmed via a direct
question):

### 1. Access control reuses `TELEGRAM_AUTHORIZED_USER_IDS` -- already built in Module 1

Checked before proposing anything new: the allowlist config already
existed (`config.telegram.authorizedUserIds: number[]`), just never
enforced anywhere. `accessControl.ts`'s `authorizedOnly()` middleware is
registered first on the bot -- an update from an unlisted `ctx.from.id`
is **silently dropped** (no reply, `next()` never called), logged at
`warn` server-side only. Replying "unauthorized" to a stranger would
itself leak that the bot is alive and responsive -- information nobody
outside the allowlist needs.

### 2. `/pause` and `/resume` are in scope, with a two-step confirmation

`INTERFACES.TELEGRAM.CONTROL_AND_REPORTING_ONLY: true` was already a
locked Module 1 constant -- "control," not just reporting. Both commands
call the same `POST /control/pause`/`resume` every other client would use,
but first arm a 30-second, per-chat, in-memory confirmation
(`confirmation.ts`'s `ConfirmationStore`) -- only a reply of exactly
`yes` within the window triggers the real call; anything else (a
different message, silence, "no") cancels it. This is deliberately **UX
friction, not a safety mechanism** -- the real safety already lives in
`api/`'s JWT auth and the pause semantics themselves (Module 10). It
exists because a chat command has no undo-click the way a UI button does.

### 3. Six commands; `/report` scoped down after a real data-gap finding

`/status`, `/positions`, `/stuck`, `/cooldowns`, `/logs [n]` map 1:1 to
their Module 10 endpoints, zero new business logic. `/logs [n]` passes
`n` straight through as `?limit=n` -- the API already clamps the range
(default 100, max 1000); `telegram/` only rejects `n` before ever calling
the API if it isn't a plausible positive integer at all.

`/report`'s originally-requested shape (realized PNL + fee earned for
CLOSED positions) turned out not to be buildable from what's actually
persisted -- traced to the root, not assumed: `Position` stores
`entryUsdgRaw` but no final-realized-USDG field; `exits/swapTx.ts`'s
`verifyOnChain` DOES compute the real `usdgIncreaseRaw` from the swap leg,
but `exits/executeExit.ts` discards it before calling `markClosed`; and
even that value alone would be incomplete, since USDG settled directly by
the remove-liquidity leg's `TAKE_PAIR` never shows up in the swap leg's
before/after balance diff (`removeLiquidityTx.ts`'s `verifyOnChain` only
checks `liquidity === 0`, reads no balance at all). A correct number needs
both legs to capture and persist something -- real, money-correctness
surgery inside Module 8's exit flow, not a small query param, and not
something to build silently as a side effect of a chat command.

**Scoped down for this module**: `/report` maps to a new
`GET /positions?status=closed` (new `PositionRepository.findAllClosed()`,
same pattern as `findAllOpening`/`findAllClosing`) returning
`tokenSymbol`/`entryUsdgRaw`/`closedAt`/`closeReason` only -- no PNL/fee
numbers, and the reply says so explicitly ("PNL/fee realized belum
tersedia"). Deliberately does NOT call `computePositionMetrics` for a
closed position -- that function needs LIVE on-chain state a closed
position no longer has; calling it would produce a meaningless number (0
liquidity → "-100% PNL"), not a real one. **The realized-PNL gap itself
is a flagged, open TODO** -- closing it properly needs its own dedicated
pass through Module 8, with the same numeric-proof discipline as every
other money-path change in this project.

### 4. Dependencies already present -- checked, not assumed

`telegraf@4.16.3` was already installed (Module 1); `TELEGRAM_BOT_TOKEN`/
`TELEGRAM_BOT_NAME`/`TELEGRAM_AUTHORIZED_USER_IDS` already existed in
`.env.example`/`env.ts`. Nothing new to install. `TELEGRAM_BOT_TOKEN`
gained format validation (`<bot_id>:<35-char-secret>`, only enforced when
non-empty -- Telegram stays an optional integration).

### 5. Bot-to-API auth: a new plaintext credential, reusing the human admin's own password

The bot is itself an API consumer -- it logs in via `POST /auth/login`
with admin credentials at startup, per explicit design. Config only ever
stored `AUTH_ADMIN_PASSWORD_HASH` (bcrypt) -- `.env.example`'s own
comment says "never the plaintext." A same-host, unattended process has
no human to prompt for a password at boot, so a plaintext credential has
to live somewhere; a new `AUTH_ADMIN_PASSWORD` env var was added,
required (enforced by a `superRefine` at config load, refusing startup
outright) whenever `TELEGRAM_BOT_TOKEN` is set.

**Why this reuses the human admin's own credential instead of a separate
service token/API key** (raised explicitly in review, not overlooked):
a dedicated service credential -- a static per-process API key, or a
long-lived JWT signed at deploy time -- is the architecturally cleaner
choice, since it could be rotated or revoked independently of the human
admin's actual login password. The reason it wasn't built that way here
is pragmatic, not an oversight: `.env` in this project already stores the
private key controlling real on-chain funds -- if that file leaks, one
more plaintext field (an admin password) doesn't materially change the
severity, both are already fatal. Given that existing trust level, reusing
the human credential is simpler for a single-operator bot and consistent
with everything else already living in `.env` at that same trust tier. A
dedicated, independently-rotatable service credential remains the better
design if this project ever needs multiple bot/API clients with different
lifecycles -- not needed yet, so not built speculatively.

### `telegram/apiClient.ts` -- login lifecycle

`login()` does one attempt; `loginWithRetry(signal?)` wraps it in an
**unbounded** exponential backoff (2s → 4s → ... capped at 60s) --
deliberately never throws, never gives up ("JANGAN crash-loop tanpa
henti"): an unreachable API at startup (this races against
`startApiServer`) or a stale password must degrade to "keep trying, log
clearly," never "exit and let a process supervisor restart into the same
failure forever." `signal`, if aborted, stops the loop -- needed because a
plain `setTimeout`-based backoff wait would otherwise keep Node's event
loop alive indefinitely if the API is never reachable; `src/index.ts`
aborts it on shutdown so a stuck bot login can't block the process from
ever exiting. Verified concretely, not assumed: a test aborts mid-wait and
asserts the real elapsed time is far under the 2-second base delay,
proving the underlying timer was genuinely cancelled (`clearTimeout`), not
just raced against a resolved promise.

On any request, a `401` (expired token -- there is no `/auth/refresh`,
confirmed not built in Module 10) triggers exactly one re-login and one
retry of the same request; a second `401` (or a re-login failure)
surfaces as a real error. Every command handler catches any `apiClient`
error into the single polite fallback message ("Gagal mengambil data,
coba lagi sebentar.") -- never a raw error or stack reaches the chat.

### Testing

44 new tests (549 total, up from 505): `apiClient.test.ts` (login,
401-triggers-one-re-login-then-retry, a second 401 surfacing as an error
not a loop, the backoff sequence, never-throws-after-many-failures using a
bounded deterministic failure count rather than a real-time abort race --
an earlier draft of that specific test raced an injected instant-resolving
`sleep` against a real `setTimeout`-based abort and crashed the test
process with an out-of-memory error from microtask starvation, fixed by
removing the race entirely); `accessControl.test.ts` (authorized passes
through, unauthorized is dropped with NO reply, explicitly asserted, not
just "next() wasn't called"); `confirmation.test.ts` (arm/consume/expire/
per-chat independence); `commands.test.ts` (one test per command's success
shape and its error fallback, `/logs` argument validation); a
`GET /positions?status=closed` addition to `tests/api/positions.test.ts`.
A real-Prisma smoke script exercised the full chain end-to-end -- a real
`Telegraf` bot instance driven via `bot.handleUpdate()` (telegraf's own
supported way to feed a synthetic update through its real middleware/
command pipeline, `Telegram.prototype.callApi` patched so `ctx.reply()`
is captured locally instead of requiring a real Telegram connection or
token) against a real API server and real SQLite: an unauthorized user's
`/report` produced no reply at all, an authorized user's `/report`
round-tripped Telegram handler → HTTP → API → repository → a genuinely
persisted CLOSED position, correctly disclosing PNL/fee as unavailable.
`GET /status`/`GET /positions` (ACTIVE) were deliberately left out of the
smoke script -- both transitively need a real Robinhood Chain RPC
endpoint unreachable from this sandbox, same flagged limitation as Module
10's own smoke test; their logic is already fully covered against fake
RPC ports in `tests/api/`. Full typecheck, full build, full suite all
clean; all smoke-test artifacts removed afterward.

### Scope note

`ui/` remains unbuilt, as scoped -- it will be the second client of the
same API. The realized-PNL/fee-earned gap (Decision 3) and
`swap/tradingApiClient.ts`'s unverified endpoint shape (Module 8) both
remain open, flagged TODOs before any of this touches real funds.

## Module 12 (final) — `ui/`

The second and last client of Module 10's API, closing out the project.
Same boundary as `telegram/`: `ui/` talks to `api/` ONLY over HTTP, never
imports `positions/`/`capital/`/etc. -- the browser can't import
server-side TypeScript anyway, but the same discipline applies to what
the UI is allowed to COMPUTE (no client-side business logic beyond
mirroring server validation for instant feedback).

### Decisions locked before any code was written

**0. Stack: vanilla TypeScript, no framework, no bundler** (confirmed via
question -- `package.json` was checked directly first, confirming zero
frontend tooling existed since Module 1). `ui/src/*.ts` compiles via a
dedicated `tsconfig.ui.json` (browser target, native ES modules) to
`ui/dist/*.js`, served statically by the same Express app `api/server.ts`
already builds. Zero new runtime dependencies -- consistent with every
prior "reuse the platform over adding a library" choice in this project
(native `fetch`, no WebSocket, no new HTTP client). Real, accepted
trade-off: more verbose DOM code, no hot-reload dev loop.

**1. Playwright added as a devDependency**, specifically for
`tests/ui/smoke.spec.ts` (confirmed via question -- nothing already
installed can drive a real browser). The one new piece of infrastructure
this module adds.

**2. Same-origin serving, not CORS.** `ui/dist/` served via
`express.static`, mounted on the SAME app under a dedicated `/app` prefix
(never bare `/`, to avoid any ambiguity with the API's own top-level
routes), placed BEFORE `authMiddleware` -- the browser needs to load the
login page and app shell with no token yet. `config.api.corsOrigin` stays
untouched at its conservative default; same-origin means CORS is simply
never in the picture. No SPA-fallback wildcard route: this app never does
client-side URL routing (every "page" is a JS-driven tab switch within
one loaded `index.html`), so there's no deep-link path that could 404.

**3. JWT storage: `sessionStorage`.** With no refresh endpoint and a
15-minute expiry, `localStorage`'s longer persistence buys nothing (full
re-auth is mandatory every 15 minutes regardless of where the token
sits), and pure in-memory forces a re-login on every accidental reload
for no real security gain -- an XSS payload running in the page can read
a JS variable exactly as easily as `sessionStorage` (the "in-memory is
XSS-resistant" argument doesn't hold for same-page script injection).
`sessionStorage` is the actual sweet spot: gone when the tab closes,
survives a reload within the session.

**4. 401 handling: deliberately NOT `telegram/`'s auto-relogin pattern.**
`telegram/apiClient.ts` stores a plaintext password and re-logs-in
transparently because that process has no human to prompt. `ui/` has a
real operator at the keyboard -- a plaintext password must never exist in
browser code/storage in any form. On any `401`: clear the token, tear
down to the login screen, require the operator to type their password
again. No retry, no auto-anything -- proven both by a unit test (`ui/tests/apiClient.test.ts`)
asserting `fetchFn` is called exactly once on a 401, and by the
Playwright spec injecting a real invalid token against the real API and
confirming the bounce-back with no second attempt.

**5. New endpoint: `GET /settings`.** Module 10 only ever built the write
side (`PATCH`) -- nothing read current values before an operator edited
them. Small, reuse-only addition (`deps.settings.get()`, Module 10),
mirroring Module 11's `findAllClosed()` precedent. Also returns
`pnlProtectionTriggerPct` (the frozen `EXITS.PNL_PROTECTION.TRIGGER_PNL_PCT`,
read-only, never settable) -- added specifically so `ui/validators.ts`'s
client-side mirror of the `hardStopLossPct` cross-check (Decision 3b,
Module 10) reads it from this response instead of hardcoding a second
copy of the number. An earlier draft of this plan did exactly that
(hardcode it), flagged in review as the same class of risk Module 11's
`parseTelegramUserIds` extraction had already closed once -- fixed the
same structural way: one number, sourced from the server, nothing to
silently drift out of sync. `PATCH /settings`'s response shape was also
changed to speak percent (matching its own request body convention)
instead of the fraction it used to return -- a small consistency fix,
not a business-logic change, made alongside adding `GET`.

**6. Polling: per-view, matching how fast each view's data actually
changes** -- Dashboard/Positions poll every 15s (matches the backend
monitoring cadence exactly); Stuck/Cooldowns poll every 30s (still an
attention signal, but slower-moving); Logs/History are load-once +
manual refresh (deliberately viewed on-demand); Settings loads once (a
form re-polling under the operator's fingers would be actively bad UX).
Polling only runs while its view is the active tab.

**7. Pause/resume: a `window.confirm()` gate**, not a bare click. A UI
click is more deliberate than a chat command, but pause/resume is still
the single most consequential control surface in the app (globally
stops/resumes deployments), and a misclick during a shared screen is
still plausible. Native browser dialog -- zero new state/code needed,
appropriate for a single-operator internal tool.

### Two real bugs found via live browser verification, not assumed away

Before considering any of this done, the built UI was actually driven in
a real browser (this session's own browser tool) against a real running
API server -- not just typechecked and unit-tested. Two genuine bugs
surfaced this way that neither `tsc` nor a Node-based unit test could
have caught:

1. **`this.fetchFn = options.fetchFn ?? fetch`** -- assigning the bare
   `fetch` function to an object property and later calling it as
   `this.fetchFn(...)` strips its required `window` receiver. Node's
   `fetch` happens not to enforce this, so `telegram/apiClient.ts`'s
   identical pattern never surfaced it and its tests never caught it --
   but a real browser throws `TypeError: Failed to execute 'fetch' on
   'Window': Illegal invocation` on the very first request. Fixed in
   both `ui/src/apiClient.ts` (where it was actually broken) and
   `telegram/apiClient.ts` (same latent pattern, fixed defensively even
   though Node doesn't currently punish it) with `fetch.bind(globalThis)`.
2. **The settings-form success message was unobservable.** The submit
   handler set `#settings-form-status`'s text to "Tersimpan." and THEN
   called `loadSettings()`, which fully re-renders the form (fresh
   server-confirmed values) -- replacing `#settings-form-status` with a
   brand new, empty element before the message was ever visible. Caught
   by the Playwright spec (not a hunch -- the assertion genuinely timed
   out against real DOM state), fixed by reordering: reload first, THEN
   set the message on the newly-rendered status element.

Also fixed along the way: a bare `void view.load()` on any fetch failure
left an unhandled promise rejection AND a permanently blank view with no
on-screen indication anything went wrong (console-only) -- verified live
against `/status` failing for a real reason (no RPC endpoint reachable
from this sandbox). Wrapped every view load in a `safeLoad()` helper that
shows a plain "Gagal memuat data, coba lagi." message instead.

### Testing

50 new `vitest` tests (599 total, up from 549): `ui/tests/apiClient.test.ts`
(request shape, the 401-clears-and-never-retries proof, a structural
check that `ApiClient` has no password field/re-login path at all --
Decision 4), `ui/tests/validators.test.ts` (every bound at the same edge
values as `settingsSchema.ts`, the cross-field check proven against a
DIFFERENT threshold value than the real one to show it's genuinely
parameterized, not secretly hardcoded), `ui/tests/views.test.ts` (every
render function, pure string-in/string-out, including an HTML-injection
attempt in a token symbol to prove `escapeHtml` is actually applied, and
an explicit assertion that `renderHistory` never emits a PNL percentage).
Kept physically outside `tests/**` (own `ui/tests/` directory, added to
`vitest.config.ts`'s `include` alongside the existing glob) specifically
so the backend `tsconfig.json`'s typecheck never has a reason to pull in
DOM-typed files transitively; `tsconfig.ui.test.json` covers `ui/src` +
`ui/tests` together for `ui/`'s own typecheck.

`tests/ui/smoke.spec.ts` (Playwright, `npm run test:e2e`): real API
server (Module 10's real-Prisma throwaway-DB pattern), real built
`ui/dist`, real headless Chromium -- login (success and wrong-password),
every read-only view against seeded real data (a CLOSED position, a
stuck `TransactionAttempt`), the settings form's client-side cross-field
validation against the REAL fetched threshold plus a real `PATCH`
verified via a fresh Prisma read, the pause/resume confirm dialog (both
accepted and dismissed, proving the gate genuinely blocks the dismissed
case), and the 401-bounces-to-login proof with an injected invalid token.
Requires `npm run build` first (builds both `dist/` and `ui/dist/`) --
`playwright.config.ts` does not build anything itself. All artifacts
(throwaway DB, `test-results/`, `playwright-report/`) cleaned up/gitignored.

`GET /status`/`GET /positions` (ACTIVE) were exercised live and by
Playwright but their assertions don't depend on real RPC succeeding --
both transitively need a real Robinhood Chain RPC endpoint unreachable
from this sandbox, the same flagged limitation as every prior module's
real-chain dependency.

Full `npx tsc --noEmit -p tsconfig.json` (backend) AND
`npx tsc --noEmit -p tsconfig.ui.test.json` (ui/, src + tests together) --
both clean. Full `npx vitest run` (599/599). Full backend build. Full
Playwright suite (6/6).

### Project scope note

This is the last module. `api/`, `auth/`, `telegram/`, and `ui/` are all
now built, closing out the original spec's four-part interface layer on
top of the trading engine (Modules 1-9). Two flagged, open items remain
before any of this should touch real funds: the realized-PNL/fee-earned
gap (Module 11/12, `Position.realizedUsdgRaw` never persisted) and
`swap/tradingApiClient.ts`'s unverified real endpoint/JSON shape (Module 8).

## Validation phase — LOW_YIELD metric resolution

Tier 3 shipped LOW_YIELD enabled with a flagged metric mismatch: Meridian's
rule gates on **pool-level `fee_24h / TVL`** (Meteora API), while the Lunex
wiring fed it `computePositionMetrics`'s `yieldPct` — this position's own
cumulative uncollected fees ÷ its entry capital. Same 0.0005 threshold
applied to a different quantity over a different window; the direction of
the error depends on position age (young positions under-read against the
floor, old ones over-read), so no threshold value makes the numbers
equivalent.

**Data-source audit** (why the Meridian metric cannot be reproduced here):

| Meridian needs | Lunex has |
|---|---|
| Pool TVL | Nothing. `StateViewPoolStateProvider.getLiquidity` returns raw `uint128` liquidity units — not a USD value; no whole-pool position-set reconstruction exists anywhere in the codebase. |
| Pool fees (24h window) | Nothing at pool level. Only per-position uncollected fees via v4 fee-growth accounting (`positionStateReader.ts` → `feesFromGrowth`). |
| 24h fee data | Nothing. `SwapLogPoolVolumeProvider` derives 6h **volume** (not fees) from `PoolManager.Swap` logs, and its own doc comment flags it best-effort and recommends an indexer/subgraph for production. GMGN's `gas_fee` is token-level, all-time, native-currency — a different quantity on every axis. |
| Position fees / age | Real and exact (v4 fee-growth math; `Position.openedAt`). |

**Resolution** (per the validation brief's decision rule — no invented
conversion, no substitute metric kept alive under the rule's name):

- `EXITS.LOW_YIELD.ENABLED` is now `false`. The rule's logic, its
  `LOW_YIELD` reason string, its priority-7 ladder position, and both
  Meridian parameter values (`MIN_AGE_MS: 30min`, `MIN_FEE_YIELD_PCT:
  0.0005`) are unchanged — disabling a rule is a policy default, not a
  removal. The reason remains in `EXIT_TRIGGER_REASONS` and flows through
  every reporting surface (the reporting test drives off that list).
- `resolveExitDecision`'s missing-data guards are untouched: null yield
  or unknown age still never fires the rule.
- Regression tests pin three facts: the config default is disabled;
  an orchestrator-level run under the shipped config leaves a
  would-have-closed position (60min old, zero fees, in range, ~-2.9%
  PnL) ACTIVE; and the same position closes for LOW_YIELD when the rule
  is enabled via `RunExitCycleDeps.exitRulesOverride` (a test-only
  injection point added alongside the existing `priceHistory` pattern),
  proving the default flip is policy, not breakage.
- **Re-enabling** requires wiring a real pool-level fee/TVL feed with a
  24h window into `ExitMetricsSnapshot.yieldPct` first, then validating
  it against an external reference. `computePositionMetrics`'s
  position-level `yieldPct` (still computed and reported — it is a real,
  correct number for what it measures) must not be reused for this rule.

What Lunex computes today, stated precisely: **position-level yield-to-date
= uncollected fees (USDG-converted at the current pool price) ÷ entry
capital, cumulative since entry, not annualized**. That metric is reported
per position (`GET /positions`, `/status` Telegram, UI) and is fit for
that purpose; it is not `fee_24h / TVL` and must not gate LOW_YIELD.

## Validation phase — realized-PnL persistence

Module 11/12's oldest flagged gap ("no realized PnL is persisted —
`Position.realizedUsdgRaw` never existed") is resolved. The exit flow now
measures and persists what each exit actually returned, and reporting
shows it.

**How it is measured** (the design constraint that shaped everything
else): the wallet runs up to 3 concurrent positions, so a
balance-before/after delta around either exit leg can be corrupted by
another cycle's mint/exit landing in the same wallet between the two
reads. Each leg's proceeds are therefore decoded from **that leg's own
confirmed transaction receipt** — every ERC20 `Transfer(... -> wallet)`
of USDG in the remove-liquidity receipt and the swap receipt, summed per
transaction (`blockchain/erc20.ts`'s `readErc20TransfersTo`). A specific
transaction's log list is scoped to exactly that transaction's effects;
concurrent wallet activity cannot enter it by construction, and the
number is exact down to the last raw unit.

**Where it lives:**
- Each leg's measured proceeds ride the SAME crash-safe `verifyData`
  persistence every other post-verification payload uses
  (`RemoveLiquidityVerifyData.usdgProceedsRaw`,
  `SwapVerifyData.usdgProceedsRaw`) — a crash between verify and close
  replays the decoder against the same confirmed hash on resume.
- `finalizeClose` sums the two legs from the VERIFIED attempts and
  persists `Position.realizedUsdgRaw` in the SAME atomic update as the
  CLOSED transition — proceeds and state can never disagree.
  Realized PnL is computed at read time (`realizedUsdgRaw −
  entryUsdgRaw`), never stored as a third denormalized number.
- Migration `20260912100000_add_position_realized_usdg` — one
  non-destructive ADD COLUMN; legacy CLOSED rows keep NULL.

**Honest-unavailable semantics, unchanged in spirit from Module 11:** a
leg whose verifyData predates the proceeds fields (a crash mid-close
under the old build, or any legacy row) yields `realizedUsdgRaw: NULL` —
never a silently under-counted sum, and never a fabricated 0. The close
itself is never blocked by an unmeasurable accounting read. Reporting
(`GET /positions?status=closed`, Telegram `/report`, UI history) shows
the number when measured, `n/a` / `-` when not.

**Safety-rule compliance:** the proceeds measurement is strictly additive
to the existing verification logic — the swap leg's balance-delta check
and the remove-liquidity leg's liquidity-zero check are untouched and
still decide VERIFIED on their own; a proceeds-decode RPC failure inside
`verifyOnChain` returns a RESUMABLE `ok: false` (the leg is never marked
definitively failed over a side-measurement — "prefer a resumable state
over a false definitive failure").

**Verification:** unit tests prove the exact sum (480 + 490 = 970
persisted), the legacy-shape honest-null, the proceeds-read-failure
resumable path, and the API/UI rendering of measured vs unmeasured
rows; the real-SQLite integration test proves the migration applies and
the column round-trips an extreme 18-decimal value with strict equality.

## LIVE VALIDATION CHECKLIST (Phase 5)

Phase 5's goal was to prepare for controlled live validation WITHOUT
executing any trade. This section is the operator's runbook: exact
commands, required environment, expected output, and the safety
guarantees of each step. **No transaction is broadcast by anything in
this checklist.**

### Environment audit — every required variable

Sources: `RPC_URL` from your Robinhood Chain RPC provider; `PRIVATE_KEY`
from your KMS/vault (development: a dedicated throwaway key with ONLY the
validation funds you can afford to lose); Trading API values from
<https://trade-api.gateway.uniswap.org>; protocol addresses confirmed
against the Trading API's own address book (`GET /v1/supported_chains?chainIds=4663`,
public, no auth).

| Variable | Required | Safe default? | Behaviour when missing/wrong |
|---|---|---|---|
| `RPC_URL` | YES | `.env.example` ships a placeholder — must be replaced | Process refuses to start (zod `z.url()` validation) |
| `CHAIN_ID` | YES | `0` in `.env.example` — must be `4663` | Refuses to start (positive-int check); `validate-live rpc` independently cross-checks the RPC's reported chain id |
| `PRIVATE_KEY` | YES | none — must be provided | Refuses to start (0x + 64-hex check) |
| `USDG_TOKEN_ADDRESS` | YES | none | Refuses to start |
| `USDG_DECIMALS` | 18 default | safe (USDG is 18-decimal) | — |
| `UNISWAP_V4_POOL_MANAGER_ADDRESS` | YES | `0x8366…0951` — **confirmed** vs Trading API address book | StateView binding self-check fails loudly at first read if mismatched |
| `UNISWAP_V4_POSITION_MANAGER_ADDRESS` | YES | `0x58da…4fA7` — **confirmed** | PositionManager binding self-check fails loudly |
| `UNISWAP_V4_STATE_VIEW_ADDRESS` | YES | `0xF333…673b` — **confirmed** | Same binding self-check |
| `UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK` | needed for pool discovery | `0` — **NOT safe**: discovery would scan from genesis | `validate-live rpc` FAILS the deploy-block check until set (find it via the block explorer) |
| `UNISWAP_ALLOWED_SWAP_ROUTER_ADDRESS` | YES for any swap | now ships `0x8876…0904` — **confirmed** (Universal Router on 4663, Trading API address book) | **Fails closed**: `validateSwapQuote` rejects every swap while empty |
| `UNISWAP_API_KEY` | YES | none | Refuses to start (mandatory exit-flow dependency) |
| `UNISWAP_TRADING_API_BASE_URL` | optional | `https://trade-api.gateway.uniswap.org` — confirmed vs live OpenAPI | — |
| `DATABASE_URL` | YES | `file:./data/lunex.db` | Refuses to start |
| `AUTH_ADMIN_USERNAME` / `AUTH_ADMIN_PASSWORD_HASH` / `JWT_SECRET` | YES | none | Refuses to start |
| `GMGN_CLI_PATH` / `GMGN_API_KEY` | needed for discovery | `gmgn-cli` default path | Discovery fails loudly per candidate, never silently |
| `EXIT_IMPACT_CHECK_ENABLED` | optional | `true` (Tier 3, Meridian 0.5% gate) | safe |
| `EXIT_MIN_RECEIVED_PROTECTION_ENABLED` | optional | `false` (post-hoc defence-in-depth) | safe |
| `API_PORT`/`API_HOST`/TLS vars | optional | `8443`/`0.0.0.0`/empty | API server startup depends on them; not part of quote-only validation |

### Step 0 — gates (no network)

```bash
npm test            # 800 passed expected
npm run typecheck   # clean
npm run lint        # clean (eslint.config.js added in Phase 5)
npm run build       # clean
```

### Step 1 — read-only RPC validation

```bash
node dist/validate-live.js rpc --i-understand-this-is-live-validation
```

Exercises, against the real RPC: latest block, chain-id cross-check,
executor native + USDG balances (address only — the private key is never
used to sign), the StateView↔PoolManager binding self-check, the
deploy-block sanity check, PoolManager event logs, PositionManager code
presence, receipt lookup, and the NFT `ownerOf` path. Expected output:
9 `[PASS]` lines and exit code 0. **Never sends a transaction.**

### Step 2 — quote-only Trading API validation

```bash
node dist/validate-live.js quote <TOKEN_ADDRESS> <AMOUNT_IN_RAW> \
  --i-understand-this-is-live-validation
```

e.g. `AMOUNT_IN_RAW=100000000000000` (0.0001 of an 18-decimal token —
deliberately tiny). Fetches a real quote once per slippage tier
(100/200/300 bps → `slippageTolerance` 1/2/3 percent), printing: input
amount, expected output, the API's `priceImpact`, our derived
`minOutputAmountRaw`, the API's own `minimumAmount` and `slippage` echo,
the approval spender, and the fail-closed router allow-list result.
**Never signs, never calls `/v1/swap`, never broadcasts.**

Both subcommands refuse to run (exit 2) without the explicit
`--i-understand-this-is-live-validation` flag — checked before any
config-reading module is even imported.

### Phase 5 contract verification results (recorded)

Against the live OpenAPI spec (`/v1/api.json`, fetched directly):

- **FIXED — real bug**: the quote request field is `slippageTolerance`,
  not `slippage` (that is the *response* field's name). The old code sent
  the ladder tier under the wrong name; the API silently ignored it and
  quoted at its own default tolerance. Every real exit swap would have
  been unbounded relative to the intended tier.
- Confirmed correct: `x-api-key` header auth; `x-permit2-disabled`
  header (now spec-verified, no longer a flagged guess);
  `ClassicQuote.priceImpact` is 0-100 → /100 to a fraction; `/v1/swap`
  request `{ quote }` shape; `swap.to/data/value/chainId`; `check_approval`
  `approval: null | {to, data}` shape.
- Routing reject list extended with the live enum's `DUTCH_LIMIT` and
  `LIMIT_ORDER` (off-chain order flows this pipeline cannot execute).
- The zod deprecation findings from lint (`z.url()`, `.loose()`) were
  migrated in the same pass.

### Lint (Phase 5)

`eslint.config.js` — the smallest config matching existing conventions:
typescript-eslint `flat/recommended-type-checked` + `flat/strict-type-checked`,
no formatting rules. 139 findings → 0: the genuine code issues were fixed
(dead post-narrowing guards, redundant `BigInt()`/`Number()`/`Number()`
conversions, unsafe `any` from `res.json()`, non-Error promise
rejections, no-op `async`, catch-variable `unknown` typing), and two
documented exceptions remain in the config:
`restrict-template-expressions` reverted to the recommended preset's
default options (`allowNumber`/`allowNullish: true` — the codebase's
raw-unit `${number}`/`${bigint}` logging idiom is what the rule's own
default permits; only the strict preset tightens it), and
`no-unused-vars` `args: 'none'` (test doubles inject-and-ignore by
design). One inline `eslint-disable` exists, at
`src/positions/openPosition.ts` — a documented defense-in-depth runtime
guard the type system considers unreachable; the comment there explains
why it stays.

### Safety warnings

- The quote harness talks to REAL services with your REAL `.env`. It
  reveals nothing secret (the wallet address only), but quotes are
  observable by the API provider as activity.
- `UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK` still ships as `0`; do not run
  the full bot until it is set, or pool discovery will attempt a
  genesis-to-latest log scan.
- Nothing in this phase validates a real fill. Price-impact accuracy,
  the derived Bollinger series, and Trading-API slippage behaviour
  against a real swap remain unmeasured until a deliberate, tiny,
  separately-approved real transaction is made (Phase 6's decision, not
  this phase's).

## PUBLIC CONFIGURATION — VERIFIED VALUES (Phase 5 completion)

Every value below was discovered from a primary public source and
independently cross-checked. The full evidence trail is recorded so a
future operator can re-verify each one.

### Address book (chain 4663, Robinhood Chain)

| Contract | Address | Sources (all agree exactly) |
|---|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 1) Uniswap Trading API `GET /v1/supported_chains?chainIds=4663`; 2) official Uniswap v4 deployments docs (developers.uniswap.org/contracts/v4/deployments); 3) on-chain: code present, and `StateView.poolManager()` returns exactly this address (live `eth_call`); 4) robinscan verified-source page shows `lib/v4-core/src/PoolManager.sol` at this address |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 1) + 2) as above; 3) on-chain code present; 4) robinscan label "Uniswap V4: Position Manager"; 5) HoodScan project registry |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 1) + 2) as above; 3) on-chain code present + its `poolManager()` binding returns the PoolManager address; 4) robinscan label "Uniswap V4: State View" |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | 1) + 2) as above; 3) on-chain code present; 4) HoodScan registry ("UniversalRouter", kind: router) |

### Deploy blocks (creation transactions, verified)

All four were deployed through the well-known deterministic CREATE2 proxy
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) by the same deployer
(`0x9701fb0a…3a52`) — consistent with Uniswap's deterministic-deployment
practice. For each: the creation tx was found via robinscan's
`/api/addresses/<addr>/contract-context`, its block confirmed against a
live node's `eth_getTransactionByHash` (both agree), and the internal
`create2` record's `createdContract` matches the address exactly.

| Contract | Creation tx | Block | Cross-checked |
|---|---|---|---|
| PoolManager | `0x4fb28d4935866f462582c6c931c6f2705e55f5be5eb178c7d8d9329a95c44c41` | **9070** (2026-05-22T18:04:55Z) | robinscan block record + live `eth_getTransactionByHash` + internal create2 createdContract match |
| PositionManager | `0x228c18ada6cb46b4fbcc18f4ec1519953415393e256fa8349aafbd5a2db037c8` | **9073** (2026-05-22T18:04:55Z) | same three-way check |
| StateView | `0x3d61e2c9eeb482385b1aa436b9e8f812167ea579cc390e4f93bc5abde00582f4` | **9075** (2026-05-22T18:04:56Z) | same (block from live RPC) |
| Universal Router | `0x422569c99e80a452d45680fbf16cf04cd4ae79cd2b0d7a6a89cf6603009ed1fa` | **18127** (2026-05-26T22:22:22Z) | same (block from live RPC) |

### RPC endpoints

| Endpoint | Status |
|---|---|
| `https://rpc.mainnet.chain.robinhood.com` | Official (Robinhood-operated), from the canonical `ethereum-lists/chains` registry `eip155-4663.json`. NOT reachable from this development network — the operator must verify reachability from THEIR network before relying on it. |
| `https://robinhood-rpc.publicnode.com` | Community (PublicNode). Live: `eth_chainId` = 0x1237 = 4663. Free tier serves latest-state reads and receipts but gates `eth_getLogs` and historical state behind a paid archive token. |
| `https://rpc.ordofi.network` | Community. Live: chainId 4663 confirmed; serves recent-window `eth_getLogs`; deep historical state (`eth_getCode` at old blocks) unavailable. |

**Operator guidance**: the bot's pool discovery scans logs from the
PoolManager deploy block (9070) to latest — that works on an endpoint
that serves `eth_getLogs` over a bounded recent window per request, but
reconciliation and any deep lookback need archive access. Use the
official endpoint (verify reachability) or a paid archive RPC for
production; the free community endpoints are for validation only.

### Live harness results (this phase, read-only)

Against `https://rpc.ordofi.network` with a throwaway key:
**8/9 PASS** — latest block, chainId match, StateView↔PoolManager
binding, deploy block, PoolManager logs, PositionManager code, receipt
lookup, NFT ownerOf. The single FAIL is the USDG `balanceOf` read against
a PLACEHOLDER token address — the real `USDG_TOKEN_ADDRESS` is an
operator value this repository has no independent verification for and
deliberately does not guess.

Quote harness with a placeholder API key: all three tiers fail cleanly
with the API's own `401 Unauthorized` error shape (correct fail-loud
behaviour), and the router allow-list check PASSES against the verified
Universal Router address. `/v1/swap` was never called; nothing was
signed. A real quote requires the operator's real API key.

## P1 fix — proceeds-read failure after a confirmed exit leg

**Bug.** Both exit legs' `verifyOnChain` (`exits/removeLiquidityTx.ts`,
`exits/swapTx.ts`) caught a failed receipt-log proceeds read and
*returned* `{ ok: false }` — which `executeCriticalTransaction` records as
a definitive `VERIFICATION_FAILED`, contrary to the code's own comments.
Consequences, had an RPC read blipped at that exact moment:

- remove-liquidity: the burn had landed, but `executeExit` reverted the
  position to ACTIVE (`markExitFailed`) over an LP that no longer existed;
- swap: an already-filled swap counted as failed, `swapAttemptCount` was
  bumped and a fresh swap attempt started against a ~0 TOKEN balance.

A related gap surfaced in the same path: a swap attempt left at
SIGNED/SENT/CONFIRMED (broadcast uncertain, receipt wait interrupted) was
resumed by re-reading the live TOKEN balance — already ~0 once the swap
filled — which threw the "invariant violated" error on every tick.

**Fix (no strategy change — exit triggers, thresholds and slippage tiers
are untouched):**

- `TxSafetyDeps.verifyOnChain` may return `{ ok: false, resumable: true }`
  for "on-chain effect proven, a read needed to finish verifying it
  failed". The pipeline keeps the attempt at CONFIRMED with no
  `failureCode`; the next call with the same key re-runs only
  `verifyOnChain` — nothing is rebuilt, re-signed or re-broadcast.
  Omitted/false keeps the original definitive meaning.
- Both exit legs use it for the proceeds read only; a non-zero liquidity
  read or an insufficient balance increase stays definitive.
- The swap leg persists the balance increase it accepted
  (`ExitState.swapVerifiedUsdgIncreaseRaw`, migration
  `20260913000000_add_exit_state_swap_verified_increase`, reset per new
  attempt), so a resumed verification never re-reads a balance that a
  concurrent mint may have moved.
- `executeExit` resumes a swap attempt that already holds a signed payload
  directly under its key, with resume-only deps (`quote: null`) — no
  balance read, no re-quote, no approval, no second swap.

**Tests:** pipeline (CONFIRMED retained, resume re-runs only verify,
repeated failures never escalate, explicit non-resumable still FAILED),
both legs' verify functions, four `executeExit` end-to-end scenarios
(remove-leg and swap-leg proceeds failure, interrupted receipt wait with
TOKEN balance 0, resumed signed swap that reverted), and a real-SQLite
round-trip of the new column.
