import { defineChain, type Chain } from 'viem';
import { config } from '../config';

/**
 * Robinhood Chain isn't one of viem's built-in chain definitions, so it's
 * defined here from `config.chain` (chainId + RPC URL, from env) rather
 * than hardcoded — one place to update if the RPC or chainId changes.
 * Native currency is ETH, per the confirmed unit for GMGN's `gas_fee`
 * figure (see `discovery/gmgnMapper.ts`) and the spec's own fee filter
 * (">= 0.5 ETH").
 */
export function buildRobinhoodChain(): Chain {
  return defineChain({
    id: config.chain.chainId,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [config.chain.rpcUrl, ...config.chain.rpcFallbackUrls] },
    },
  });
}

export const robinhoodChain = buildRobinhoodChain();
