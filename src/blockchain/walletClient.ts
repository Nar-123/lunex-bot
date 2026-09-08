import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from '../config';
import { robinhoodChain } from './viemChain';

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
      transport: http(config.chain.rpcUrl),
    });
  }
  return cachedClient;
}

export function getExecutorAddress(): `0x${string}` {
  return getAccount().address;
}
