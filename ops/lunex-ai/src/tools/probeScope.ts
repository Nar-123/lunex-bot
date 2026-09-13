import { ConfigError, loadConfig } from '../config';
import type { SupervisorConfig } from '../config';
import { ScopeGuard } from '../scopeGuard';
import { collectSecretValues, createMasker } from '../secretMask';
import { buildPathProbes, COMMAND_PROBES, evaluateCommandProbes, evaluatePathProbes, formatOutcomes } from './probes';

/**
 * Deployment check: runs the DEPLOYED scope guard and command allowlist with the
 * real configuration against real VPS paths. Reads and writes nothing.
 * Exit 0 = every probe behaved as expected.
 */
function main(): void {
  const mask = createMasker(collectSecretValues(process.env));
  let config: SupervisorConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, stage: 'config', error: err instanceof ConfigError ? err.message : 'unexpected configuration error' }));
    process.exit(2);
  }
  const guard = new ScopeGuard({ workspaceDir: config.workspaceDir, aiHomeDir: config.aiHomeDir, deniedRoots: config.deniedRoots });
  const outcomes = [...evaluatePathProbes(guard, buildPathProbes(config.workspaceDir, config.aiHomeDir)), ...evaluateCommandProbes(COMMAND_PROBES)];
  console.log(mask(formatOutcomes(outcomes)));
  process.exit(outcomes.every((o) => o.pass) ? 0 : 1);
}

main();
