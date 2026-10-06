/**
 * Deployment identity probe. Run ONLY by the `lunex-deploy-identity@.service`
 * oneshot unit, as the service account, with the production EnvironmentFile and
 * no network (PrivateNetwork=yes).
 *
 * It loads the production configuration exactly the way the bot does, derives
 * the executor address with the bot's own `getExecutorAddress()`, and prints a
 * single JSON line holding the ADDRESS and the configured chain id. The private
 * key never leaves this process and is never printed. As a side effect, a
 * production `.env` that the release's config schema rejects fails here, before
 * any deployment step runs.
 */
import { getExecutorAddress } from '../blockchain/walletClient';
import { config } from '../config';

try {
  process.stdout.write(`${JSON.stringify({ event: 'deploy_identity', executor: getExecutorAddress(), chainId: config.chain.chainId })}\n`);
} catch (err) {
  // config/env.ts reports schema issues as `path: message` only -- never values.
  process.stdout.write(`${JSON.stringify({ event: 'deploy_identity_failed', reason: err instanceof Error ? err.message : 'unknown error' })}\n`);
  process.exitCode = 1;
}
