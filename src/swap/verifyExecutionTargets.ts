import { keccak256, type Address } from 'viem';
import { getPublicClient } from '../blockchain/viemClient';
import { config } from '../config';
import { normalizeAddress, SWAP_PROXY_EXECUTE_SELECTOR, type ExecutionTargetPolicy } from './executionTargets';
import { setExecutionTargetVerification } from './executionTargetGate';

/**
 * READ-ONLY identity assertion for the configured execution targets, run once
 * at startup. It calls nothing that writes: `eth_chainId`, `eth_getCode` and a
 * single `poolManager()` view per router. No transaction is built, signed or
 * sent.
 *
 * What it proves before an exit swap is ever allowed to sign:
 *  - the RPC really is the configured chain (an allowlist is chain-scoped, so a
 *    silently swapped endpoint must not be able to reuse it);
 *  - every approved Universal Router has code AND its `poolManager()` returns
 *    the configured PoolManager -- the same binding check `mintTx.ts` already
 *    performs for the PositionManager;
 *  - every approved SwapProxy has code and actually exposes the `execute`
 *    entry point this project decodes (selector present in its bytecode);
 *  - when several proxies are approved, they are the same contract (identical
 *    code hash) -- a deterministic CREATE2 deployment must be byte-identical.
 *
 * On failure the gate is set to FAILED, which makes `validateSwapQuote` reject
 * every swap (fail closed). Monitoring, decisions and everything else keep
 * running; only signing an exit swap is blocked, and the refusal travels the
 * ordinary deterministic-block path so it is backed off and operator-visible.
 */

export interface ExecutionTargetVerificationReaders {
  getChainId?: () => Promise<number>;
  getCode?: (address: Address) => Promise<string | undefined>;
  readPoolManager?: (router: Address) => Promise<string>;
}

export interface ExecutionTargetVerificationReport {
  ok: boolean;
  chainId: number | null;
  checked: { address: string; kind: 'UNIVERSAL_ROUTER' | 'SWAP_PROXY'; codeBytes: number; detail: string }[];
  failures: string[];
}

const POOL_MANAGER_SELECTOR = '0xdc4c90d3'; // poolManager()

async function defaultReadPoolManager(router: Address): Promise<string> {
  const res = await getPublicClient().call({ to: router, data: POOL_MANAGER_SELECTOR });
  const data = res.data ?? '0x';
  if (data.length < 66) throw new Error(`poolManager() returned ${data.length === 2 ? 'no data' : data}`);
  return `0x${data.slice(26, 66)}`;
}

export async function verifyExecutionTargets(
  policy: ExecutionTargetPolicy = config.uniswapTradingApi.executionTargets,
  readers: ExecutionTargetVerificationReaders = {},
  expectedPoolManager: string = config.uniswap.v4.poolManager,
): Promise<ExecutionTargetVerificationReport> {
  const getChainId = readers.getChainId ?? (() => getPublicClient().getChainId());
  const getCode = readers.getCode ?? ((address: Address) => getPublicClient().getCode({ address }));
  const readPoolManager = readers.readPoolManager ?? defaultReadPoolManager;
  const report: ExecutionTargetVerificationReport = { ok: false, chainId: null, checked: [], failures: [] };

  if (policy.universalRouters.length === 0) {
    report.failures.push(`no approved Universal Router is configured for chain ${policy.chainId} -- exits cannot be authorised (fail closed)`);
  }

  try {
    report.chainId = await getChainId();
    if (report.chainId !== policy.chainId) {
      report.failures.push(`RPC reports chainId ${report.chainId}, but the execution-target policy is for chain ${policy.chainId}`);
    }
  } catch (err) {
    report.failures.push(`could not read chainId: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }

  const proxyCodeHashes = new Set<string>();
  for (const [kind, list] of [
    ['UNIVERSAL_ROUTER', policy.universalRouters],
    ['SWAP_PROXY', policy.swapProxies],
  ] as const) {
    for (const raw of list) {
      let address: string;
      try {
        address = normalizeAddress(raw, `configured ${kind}`);
      } catch (err) {
        report.failures.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      let code: string;
      try {
        code = (await getCode(address as Address)) ?? '0x';
      } catch (err) {
        report.failures.push(`${kind} ${address}: could not read code (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
        continue;
      }
      const codeBytes = (code.length - 2) / 2;
      if (codeBytes === 0) {
        report.failures.push(`${kind} ${address} has NO code on chain ${policy.chainId}`);
        continue;
      }
      if (kind === 'UNIVERSAL_ROUTER') {
        try {
          const bound = await readPoolManager(address as Address);
          const matches = bound.toLowerCase() === expectedPoolManager.toLowerCase();
          if (!matches) report.failures.push(`Universal Router ${address} is bound to PoolManager ${bound}, expected ${expectedPoolManager}`);
          report.checked.push({ address, kind, codeBytes, detail: `poolManager()=${bound}${matches ? ' (matches)' : ' (MISMATCH)'}` });
        } catch (err) {
          report.failures.push(`Universal Router ${address}: poolManager() unreadable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
        }
        continue;
      }
      const hasExecute = code.toLowerCase().includes(SWAP_PROXY_EXECUTE_SELECTOR.slice(2));
      if (!hasExecute) report.failures.push(`SwapProxy ${address} does not expose ${SWAP_PROXY_EXECUTE_SELECTOR} (execute(address,address,uint256,bytes,bytes[],uint256))`);
      const hash = keccak256(code as `0x${string}`);
      proxyCodeHashes.add(hash);
      report.checked.push({ address, kind, codeBytes, detail: `codeHash=${hash.slice(0, 18)}${hasExecute ? ' execute() present' : ' execute() MISSING'}` });
    }
  }

  if (proxyCodeHashes.size > 1) {
    report.failures.push(`approved SwapProxies do not share identical bytecode (${proxyCodeHashes.size} distinct code hashes) -- a deterministic deployment must be byte-identical`);
  }

  report.ok = report.failures.length === 0;
  return report;
}

/** Runs the assertion and publishes the result to the gate `validateSwapQuote` consults. Never throws: a failure blocks exits instead of crashing the bot. */
export async function assertExecutionTargetsAtStartup(
  log: (event: string, data: Record<string, unknown>) => void,
  policy: ExecutionTargetPolicy = config.uniswapTradingApi.executionTargets,
  readers: ExecutionTargetVerificationReaders = {},
): Promise<ExecutionTargetVerificationReport> {
  let report: ExecutionTargetVerificationReport;
  try {
    report = await verifyExecutionTargets(policy, readers);
  } catch (err) {
    report = { ok: false, chainId: null, checked: [], failures: [`verification threw: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`] };
  }
  setExecutionTargetVerification(report.ok ? 'VERIFIED' : 'FAILED', report.failures.join('; ') || null);
  log(report.ok ? 'execution_targets_verified' : 'execution_targets_verification_failed', {
    chainId: report.chainId,
    routers: policy.universalRouters,
    proxies: policy.swapProxies,
    checked: report.checked,
    ...(report.failures.length > 0 && { failures: report.failures }),
  });
  return report;
}
