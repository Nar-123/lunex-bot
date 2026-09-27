import { createWalletClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from '../config';
import { robinhoodChain } from './viemChain';
import { buildRpcTransport, resolveRpcEndpoints } from './rpcTransport';

let cachedAccount: PrivateKeyAccount | undefined;
let cachedClient: WalletClient | undefined;

function getAccount(): PrivateKeyAccount {
  if (!cachedAccount) {
    cachedAccount = privateKeyToAccount(config.executorPrivateKey as `0x${string}`);
  }
  return cachedAccount;
}

/**
 * Signing client for the executor wallet. Used ONLY to sign transactions
 * locally (`execution/`'s `SIGNED` checkpoint computes the raw tx + hash
 * before any network broadcast) -- never to send directly, so a crashed
 * process can never lose track of "did this actually go out."
 */
export function getWalletClient(): WalletClient {
  if (!cachedClient) {
    cachedClient = createWalletClient({
      account: getAccount(),
      chain: robinhoodChain,
      // The same ordered failover transport as the public client, so no client
      // can bypass endpoint policy. In practice this one makes NO network call:
      // signing is local (`getExecutorAccount()`), and broadcast/receipt reads
      // go through `getPublicClient()`.
      transport: buildRpcTransport(resolveRpcEndpoints(config.chain.rpcUrl, config.chain.rpcFallbackUrls).urls),
    });
  }
  return cachedClient;
}

/**
 * The executor's LOCAL private-key account. Signing MUST go through this
 * object: viem treats an address STRING passed as `account` as a JSON-RPC
 * account and asks the RPC node to sign (`eth_signTransaction`), which a
 * hosted RPC cannot do -- see `execution/viemTxSteps.ts`'s `signTx`.
 */
export function getExecutorAccount(): PrivateKeyAccount {
  return getAccount();
}

export function getExecutorAddress(): `0x${string}` {
  return getAccount().address;
}
