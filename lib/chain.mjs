import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, concat } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

import crypto from 'node:crypto';
import abi from './abi.js';

const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';

const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const chain = { id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
// retryCount 0 everywhere: viem's own retry would re-prepare the request, and on a
// slow RPC that means a second transaction with a second nonce and twice the gas.
const rpc = http(RPC, { timeout: 30_000, retryCount: 0 });
export const pub = createPublicClient({ chain, transport: rpc });
export const wlt = createWalletClient({ account, chain, transport: rpc });

export function address() {
  if (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS) return process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  try { return fs.readFileSync(process.cwd() + '/.address', 'utf8').trim(); } catch { return null; }
}

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s.replace('0x', ''), 'hex');

/// Rebuilds what the secure element actually signed and checks it against the key
/// the chain has on record. Cheap, so a garbage submission never costs a transaction.
/// Returns false rather than throwing on an unparseable key: x and y arrive from a
/// browser, and an x/y pair from two different keys is not a curve point at all.
export function verifySig(xHex, yHex, a) {
  try {
    const sigData = Buffer.concat([unhex(a.authenticatorData), crypto.createHash('sha256').update(unhex(a.clientDataJSON)).digest()]);
    const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex');
    const key = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, unhex(xHex), unhex(yHex)]), format: 'der', type: 'spki' });
    return crypto.verify('sha256', sigData, { key, dsaEncoding: 'der' }, unhex(a.derSignature));
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Two transactions from the same wallet always conflict on Monad, so one
/// instance sends one at a time. Retries re-derive the nonce from the chain.
let tail = Promise.resolve();
const withLock = (job) => { const run = tail.then(job, job); tail = run.then(() => {}, () => {}); return run; };

/// Sign, then broadcast: hashing the signed payload gives us the tx hash before the
/// network has answered, so a timeout is a question about the RPC, not about whether
/// the attestation escaped — and re-sending the identical bytes is a no-op.
async function broadcast(request) {
  const serialized = await wlt.signTransaction(request);
  const hash = keccak256(serialized);
  for (let i = 0; i < 5; i++) {
    try { await pub.sendRawTransaction({ serializedTransaction: serialized }); return hash; }
    catch (e) {
      const m = e.shortMessage ?? e.message ?? '';
      if (/already (known|imported)|known transaction|nonce too low/i.test(m)) return hash;
      if (i === 4) throw e;
      await sleep(1500);
    }
  }
}

export async function send(fn, args, { gasLimit = 900_000n, dedupe, wait = 8000 } = {}) {
  return withLock(async () => {
    const to = address();
    const data = encodeFunctionData({ abi, functionName: fn, args });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (dedupe) {
        const seen = await pub.readContract({ address: to, abi, functionName: 'isCommitted', args: dedupe });
        if (seen) return { hash: null, deduped: true };
      }
      const gasPrice = await pub.getGasPrice();
      let gas;
      try {
        gas = (await pub.estimateGas({ account: account.address, to, data, gasPrice })) * 12n / 10n;
      } catch (e) {
        // a dry-run revert means our own bug: refuse rather than pay for the revert
        if (!/timeout|timed out|fetch|socket/i.test(e.shortMessage ?? e.message ?? '')) throw e;
        gas = gasLimit;
      }
      const nonce = Number(await pub.getTransactionCount({ address: account.address, blockTag: 'pending' }));
      try {
        const hash = await broadcast({ account, chain, to, data, gasPrice, gas, nonce });
        try {
          const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 800, timeout: wait });
          return { hash, rc, costMono: Number(rc.gasUsed * gasPrice) / 1e18, gasPrice };
        } catch (e) {
          // A function that outlives its own request is worse than a late map. The
          // bytes are already broadcast, so hand back the hash and let the client poll.
          if (/timed out|timeout/i.test(e.shortMessage ?? e.message ?? '')) return { hash, rc: null, pending: true, gasPrice };
          throw e;
        }
      } catch (e) {
        lastErr = e;
        await sleep(1200 * (attempt + 1));
      }
    }
    throw lastErr;
  });
}

export async function deviceOf(deviceId) {
  const [x, y, lastCounter, trust, revoked] = await pub.readContract({ address: address(), abi, functionName: 'devices', args: [deviceId] });
  return { x, y, lastCounter, trust, revoked };
}

export const deviceIdOf = (xHex, yHex) => keccak256(concat([xHex, yHex]));

export { abi };
