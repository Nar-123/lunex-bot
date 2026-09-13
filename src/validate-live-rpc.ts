/**
 * PHASE 5 — the `rpc` subcommand of `validate-live.ts`. All checks are
 * READ-ONLY RPC reads against the configured Robinhood Chain endpoint;
 * see `validate-live.ts`'s header for the never-broadcast guarantee and
 * the flag gating that gets you here.
 */
import type { Address } from 'viem';
import { formatUnits } from 'viem';
import { config } from './config';
import { getPublicClient } from './blockchain/viemClient';
import { getExecutorAddress } from './blockchain/walletClient';
import { readErc20Balance, readErc20Decimals } from './blockchain/erc20';
import { ownerOfNft } from './blockchain/erc721';
import { V4_STATE_VIEW_ABI } from './blockchain/abis/v4StateView';
import { checkStateViewBinding } from './pools/poolStateProvider';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function line(char = '─'): string {
  return char.repeat(72);
}

function report(check: CheckResult): void {
  const mark = check.ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${check.name}`);
  if (check.detail) console.log(`         ${check.detail}`);
}

export async function runRpcValidation(): Promise<number> {
  const client = getPublicClient();
  const wallet = getExecutorAddress();
  const results: CheckResult[] = [];

  console.log(line());
  console.log('LUNEX LIVE VALIDATION — READ-ONLY RPC CHECKS');
  console.log(`RPC:      ${config.chain.rpcUrl}`);
  console.log(`chainId:  ${config.chain.chainId} (configured)`);
  console.log(`wallet:   ${wallet} (address only — key never used to sign here)`);
  console.log(line());

  // 1. Latest block
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    results.push({
      name: 'latest block readable',
      ok: block.number > 0n,
      detail: `block ${block.number}, timestamp ${new Date(Number(block.timestamp) * 1000).toISOString()}`,
    });
  } catch (err) {
    results.push({ name: 'latest block readable', ok: false, detail: String(err) });
  }

  // 2. Chain id matches config (a wrong-RPC/chainId copy/paste is the
  // classic silent killer: every address would read zero and every quote
  // would target the wrong chain).
  try {
    const chainId = await client.getChainId();
    results.push({
      name: 'RPC chainId matches configured CHAIN_ID',
      ok: chainId === config.chain.chainId,
      detail: `RPC reports ${chainId}, config expects ${config.chain.chainId}`,
    });
  } catch (err) {
    results.push({ name: 'RPC chainId matches configured CHAIN_ID', ok: false, detail: String(err) });
  }

  // 3. Wallet balances (read-only)
  try {
    const nativeRaw = await client.getBalance({ address: wallet });
    const usdgRaw = await readErc20Balance(config.quoteAsset.ADDRESS as Address, wallet);
    const usdgDecimals = await readErc20Decimals(config.quoteAsset.ADDRESS as Address).catch(() => config.quoteAsset.DECIMALS);
    results.push({
      name: 'executor balances readable',
      ok: true,
      detail: `native ${formatUnits(nativeRaw, 18)} ETH, USDG ${formatUnits(usdgRaw, usdgDecimals)} (${config.quoteAsset.ADDRESS})`,
    });
  } catch (err) {
    results.push({ name: 'executor balances readable', ok: false, detail: String(err) });
  }

  // 4. StateView binding self-check (the same one poolStateProvider runs
  // once per process at first read -- exercised here before anything else).
  try {
    const bound = (await client.readContract({
      address: config.uniswap.v4.stateView as Address,
      abi: V4_STATE_VIEW_ABI,
      functionName: 'poolManager',
    }));
    checkStateViewBinding(bound, config.uniswap.v4.poolManager as Address);
    results.push({
      name: 'StateView is bound to the configured PoolManager',
      ok: true,
      detail: `StateView ${config.uniswap.v4.stateView} -> PoolManager ${config.uniswap.v4.poolManager}`,
    });
  } catch (err) {
    results.push({ name: 'StateView is bound to the configured PoolManager', ok: false, detail: String(err) });
  }

  // 5. Deploy-block sanity: pool discovery scans FROM this block; 0 means
  // "never configured", which would attempt a full-chain scan.
  const deployBlock = config.uniswap.v4.poolManagerDeployBlock;
  results.push({
    name: 'PoolManager deploy block configured (non-zero)',
    ok: deployBlock > 0n,
    detail:
      deployBlock > 0n
        ? `UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK = ${deployBlock}`
        : 'UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK is 0 — pool discovery would scan from genesis. Fill in the real deploy block.',
  });

  // 6. PoolManager log scan works (the pool-discovery + volume-estimation
  // path): a short recent-window getLogs against the configured
  // PoolManager proves the RPC serves the event reads discovery depends
  // on, without paying for a full deploy-block-to-latest scan here.
  try {
    const latest = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: config.uniswap.v4.poolManager as Address,
      fromBlock: latest > 1000n ? latest - 1000n : 0n,
      toBlock: latest,
    });
    results.push({
      name: 'PoolManager event logs readable (recent window)',
      ok: true,
      detail: `${logs.length} events in the last ~1000 blocks at ${config.uniswap.v4.poolManager}`,
    });
  } catch (err) {
    results.push({ name: 'PoolManager event logs readable (recent window)', ok: false, detail: String(err) });
  }

  // 7. PositionManager exists at the configured address (a plain
  // eth_call that would throw if no contract code lives there).
  try {
    const code = await client.getCode({ address: config.uniswap.v4.positionManager as Address });
    results.push({
      name: 'PositionManager contract code present',
      ok: code !== undefined && code !== '0x',
      detail: `${config.uniswap.v4.positionManager} (${code !== undefined && code !== '0x' ? 'has code' : 'NO CODE'})`,
    });
  } catch (err) {
    results.push({ name: 'PositionManager contract code present', ok: false, detail: String(err) });
  }

  // 8. Receipt lookup path (the crash-recovery reads): pick the latest
  // block's first transaction if present; an empty block reports the
  // lookup as not exercised rather than claiming it verified.
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    const firstHash = block.transactions[0];
    if (firstHash !== undefined) {
      const receipt = await client.getTransactionReceipt({ hash: firstHash });
      results.push({
        name: 'transaction receipt lookup works',
        // viem's getTransactionReceipt throws (never returns null) when the
        // receipt is missing -- reaching here at all means the lookup
        // worked; a failure would have gone to this block's catch.
        ok: true,
        detail: `receipt for ${firstHash.slice(0, 18)}… status=${receipt.status}, block ${receipt.blockNumber}`,
      });
    } else {
      results.push({ name: 'transaction receipt lookup works', ok: true, detail: 'latest block has no transactions — lookup not exercised' });
    }
  } catch (err) {
    results.push({ name: 'transaction receipt lookup works', ok: false, detail: String(err) });
  }

  // 9. NFT ownerOf path (reconciliation reads PositionManager NFTs the
  // same way) — a nonexistent tokenId reverting cleanly proves the
  // contract responds; a thrown RPC error is a connectivity failure.
  try {
    await ownerOfNft(config.uniswap.v4.positionManager as Address, 1n);
    results.push({ name: 'PositionManager ownerOf responds', ok: true, detail: 'tokenId 1 exists' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/revert/i.test(msg)) {
      results.push({ name: 'PositionManager ownerOf responds', ok: true, detail: 'tokenId 1 does not exist (clean ERC721 revert) — contract responds correctly' });
    } else {
      results.push({ name: 'PositionManager ownerOf responds', ok: false, detail: msg });
    }
  }

  console.log();
  for (const r of results) report(r);
  const failed = results.filter((r) => !r.ok).length;
  console.log();
  console.log(line());
  console.log(`${results.length - failed} passed, ${failed} failed — NO transaction was sent at any point.`);
  return failed === 0 ? 0 : 1;
}
