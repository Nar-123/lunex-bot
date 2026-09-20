import { describe, expect, it } from 'vitest';
import { InvalidInputRpcError, RpcRequestError } from 'viem';
import { safeErrorMessage } from '../../src/execution/executeCriticalTransaction';
import { configuredSecrets, redactSecrets } from '../../src/execution/redactError';
import { config } from '../../src/config';

const RAW_TX = `0x02f8b1${'5a'.repeat(170)}`;
const API_KEY = 'AlchemyKey_abcDEF1234567890';
const DETAILS = 'err: max fee per gas less than block base fee: address 0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea, maxFeePerGas: 66172000, baseFee: 67172000 (supplied gas 100000)';

function providerError(): Error {
  return new InvalidInputRpcError(
    new RpcRequestError({ body: { jsonrpc: '2.0', id: 7, method: 'eth_sendRawTransaction', params: [RAW_TX] }, error: { code: -32000, message: DETAILS }, url: `https://robinhood-mainnet.g.alchemy.com/v2/${API_KEY}?x=1` }),
  );
}

describe('safeErrorMessage / redactSecrets', () => {
  it('keeps the provider Details (base fee, max fee, message) and the JSON-RPC code', () => {
    const msg = safeErrorMessage(providerError());
    expect(msg).toContain('InvalidInputRpcError [code -32000]');
    expect(msg).toContain('Details: err: max fee per gas less than block base fee');
    expect(msg).toContain('maxFeePerGas: 66172000');
    expect(msg).toContain('baseFee: 67172000');
    expect(msg).toContain('0x65299018ABAaa6bD89aabF689dbEf21Be99ef1Ea'); // public address stays readable
  });

  it('redacts the RPC URL path/API key, the request body and the signed raw transaction', () => {
    const msg = safeErrorMessage(providerError());
    expect(msg).toContain('URL: https://robinhood-mainnet.g.alchemy.com/<redacted>');
    expect(msg).toContain('Request body: <redacted>');
    expect(msg).not.toContain(API_KEY);
    expect(msg).not.toContain('eth_sendRawTransaction');
    expect(msg).not.toContain('5a'.repeat(20));
    expect(msg).not.toContain('"params"');
  });

  it('a raw tx echoed OUTSIDE the request body is still redacted', () => {
    expect(redactSecrets(`rejected ${RAW_TX}`, [])).toMatch(/0x<redacted \d+ bytes>/);
  });

  it('redacts Authorization / Bearer / API-key header values', () => {
    const t = redactSecrets('Authorization: Bearer abc.def.ghi x-api-key=KEY123456 apiKey: "zzz999"', []);
    expect(t).not.toMatch(/abc\.def\.ghi|KEY123456|zzz999/);
    expect(t).toContain('<redacted>');
  });

  it('redacts JWTs anywhere', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJlX2hlcmU';
    expect(redactSecrets(`token ${jwt} expired`, [])).toBe('token <redacted-jwt> expired');
  });

  it('redacts private-key-labelled 32-byte hex but keeps a transaction hash readable', () => {
    const pk = `0x${'1f'.repeat(32)}`;
    const txHash = `0x${'83'.repeat(32)}`;
    const t = redactSecrets(`private key: ${pk} tx ${txHash}`, []);
    expect(t).not.toContain(pk);
    expect(t).toContain(txHash);
  });

  it('redacts the exact configured secret values (with and without 0x) wherever they appear', () => {
    const secrets = configuredSecrets();
    expect(secrets).toContain(config.executorPrivateKey);
    expect(secrets).toContain(config.auth.jwtSecret);
    const pkNo0x = config.executorPrivateKey.slice(2);
    const t = safeErrorMessage(new Error(`leak ${config.executorPrivateKey} and ${pkNo0x} and ${config.auth.jwtSecret} and ${config.chain.rpcUrl}`));
    expect(t).not.toContain(pkNo0x);
    expect(t).not.toContain(config.auth.jwtSecret);
    expect(t).toContain(new URL(config.chain.rpcUrl).host); // host kept for diagnosis
  });

  it('a configured RPC URL keeps its host but loses its key-bearing path/query', () => {
    const t = redactSecrets('URL: https://robinhood-mainnet.g.alchemy.com/v2/KEY_abcdefgh123', ['/v2/KEY_abcdefgh123']);
    expect(t).toBe('URL: https://robinhood-mainnet.g.alchemy.com/<redacted>');
  });

  it('short/empty configured values never redact ordinary text', () => {
    expect(redactSecrets('status ok', ['', 'ok'])).toBe('status ok');
  });

  it('still bounded', () => {
    expect(safeErrorMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(800);
  });
});
