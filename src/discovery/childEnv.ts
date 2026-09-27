/**
 * Minimal child-process environment for `gmgn-cli`.
 *
 * ## Why this exists
 *
 * `GmgnCliClient.childEnv()` used to return `{ ...process.env, GMGN_API_KEY }`.
 * Spreading the parent environment hands the child EVERY Lunex secret the
 * service holds: `PRIVATE_KEY` (the executor's signing key -- the single most
 * damaging value in this process), `JWT_SECRET`, `AUTH_ADMIN_PASSWORD_HASH`,
 * `TELEGRAM_BOT_TOKEN`, `UNISWAP_API_KEY`, `DATABASE_URL` and the RPC URLs
 * (whose paths embed provider API keys). `gmgn-cli` is third-party code
 * downloaded from npm and run on every discovery cycle; it needs exactly one
 * secret, its own API key, and nothing else. A compromised or merely curious
 * version of it could read the wallet key straight out of its own environment.
 *
 * ## The rule
 *
 * Deny by default: the child gets ONLY the variables named below plus
 * `GMGN_API_KEY`. Adding a secret to Lunex's `.env` can therefore never
 * silently widen what the child sees -- a new variable has to be added to
 * this allowlist deliberately.
 *
 * Mirrors the pattern already used by the operations supervisor
 * (`ops/lunex-ai/src/commandRunner.ts`'s `ENV_PASSTHROUGH`/`buildChildEnv`),
 * deliberately re-stated here rather than imported: `ops/lunex-ai` is a
 * separate project with its own tsconfig/vitest config, and the root
 * `tsconfig.json` includes only `src/**` and `tests/**`. The supervisor's
 * test-mode additions (`CI`, `NODE_ENV=test`, `GIT_*`) are NOT copied -- they
 * are meaningful for spawning Lunex's own build/test commands and wrong for a
 * market-data CLI.
 *
 * Secrets still travel via env rather than argv (argv is world-readable via
 * `ps`); the point of this module is WHICH secrets, not the mechanism.
 */

/**
 * Non-secret variables a child process needs to run at all: executable
 * lookup, a writable temp/home directory, locale/timezone for date
 * formatting, and the Windows essentials Node itself requires when spawned
 * (`SystemRoot`, `ComSpec`, `PATHEXT`, the AppData pair).
 *
 * Deliberately absent: `HTTP_PROXY`/`HTTPS_PROXY` (a proxy URL can embed
 * credentials). An operator who genuinely needs the CLI to egress through an
 * authenticated proxy must add it here consciously.
 */
export const GMGN_CHILD_ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_cache',
] as const;

/**
 * Builds the child environment: allowlisted passthrough entries that are
 * actually set in `parent`, plus `GMGN_API_KEY` when one is configured (an
 * empty/absent key is simply omitted -- never set to `''`, which some CLIs
 * treat as "explicitly blank" rather than "unset").
 */
export function buildGmgnChildEnv(parent: NodeJS.ProcessEnv, apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GMGN_CHILD_ENV_PASSTHROUGH) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  if (apiKey) env.GMGN_API_KEY = apiKey;
  return env;
}
