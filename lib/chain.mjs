import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, concat } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

import crypto from 'node:crypto';
import abi from './abi.js';

const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';

const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
export const pub = createPublicClient({ transport: http(RPC) });
export const wlt = createWalletClient({
  account, transport: http(RPC),
  chain: { id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
});

export function address() {
  if (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS) return process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  try { return fs.readFileSync(new URL('../.address', import.meta.url), 'utf8').trim(); } catch { return null; }
}

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s.replace('0x', ''), 'hex');

/// Rebuilds what the secure element actually signed and checks it against the key
/// the chain has on record. Cheap, so a garbage submission never costs a transaction.
export function verifySig(xHex, yHex, a) {
  const sigData = Buffer.concat([unhex(a.authenticatorData), crypto.createHash('sha256').update(unhex(a.clientDataJSON)).digest()]);
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex');
  const key = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, unhex(xHex), unhex(yHex)]), format: 'der', type: 'spki' });
  return crypto.verify('sha256', sigData, { key, dsaEncoding: 'der' }, unhex(a.derSignature));
}

export async function send(fn, args, gasLimit = 900_000n) {
  const to = address();
  const gasPrice = await pub.getGasPrice();
  const data = encodeFunctionData({ abi, functionName: fn, args });
  let gas = gasLimit;
  try { gas = (await pub.estimateGas({ account: account.address, to, data, gasPrice })) * 12n / 10n; } catch { /* keep ceiling */ }
  const hash = await wlt.writeContract({ address: to, abi, functionName: fn, args, gasPrice, gas });
  const rc = await pub.waitForTransactionReceipt({ hash });
  return { hash, rc, costMono: Number(rc.gasUsed * gasPrice) / 1e18, gasPrice };
}

export async function deviceOf(deviceId) {
  const [x, y, lastCounter, trust, revoked] = await pub.readContract({ address: address(), abi, functionName: 'devices', args: [deviceId] });
  return { x, y, lastCounter, trust, revoked };
}

export const deviceIdOf = (xHex, yHex) => keccak256(concat([xHex, yHex]));

export { abi };
