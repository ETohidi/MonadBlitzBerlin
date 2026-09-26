// Deploys GroundTruth to Monad testnet and drives the full claim end to end,
// attacks included, so the stage demo is rehearsed against a real chain.
import fs from 'node:fs';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, decodeEventLog,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newDevice, attest } from '../lib/attest.mjs';

const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = 10143;
const monadTestnet = {
  id: CHAIN_ID, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

if (!process.env.SPONSOR_PRIVATE_KEY) { console.error('SPONSOR_PRIVATE_KEY missing'); process.exit(1); }
const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const pub = createPublicClient({ transport: http(RPC) });
const wlt = createWalletClient({ account, chain: monadTestnet, transport: http(RPC) });

const abi = JSON.parse(fs.readFileSync('out/GroundTruth.abi.json', 'utf8'));
const bytecode = '0x' + fs.readFileSync('out/GroundTruth.bin', 'utf8').trim();

const bal = await pub.getBalance({ address: account.address });
console.log(`sponsor ${account.address}\n  balance ${(Number(bal) / 1e18).toFixed(4)} MON`);
if (bal < 10n ** 16n) { console.error('  -> not enough testnet MON'); process.exit(1); }

async function tx(to, functionName, args) {
  const gasPrice = await pub.getGasPrice();
  const data = encodeFunctionData({ abi, functionName, args });
  let gas = 5_000_000n;
  try { gas = (await pub.estimateGas({ account: account.address, to, data, gasPrice })) * 12n / 10n; } catch (e) {
    console.log(`  estimate failed for ${functionName}: ${e.shortMessage ?? e.message}`);
  }
  const hash = await wlt.writeContract({ address: to, abi, functionName, args, gasPrice, gas });
  const rc = await pub.waitForTransactionReceipt({ hash });
  return { rc, gasPrice, functionName };
}

function report({ rc, gasPrice, functionName }, note = '') {
  const cost = Number(rc.gasUsed * gasPrice) / 1e18;
  console.log(`  ${functionName.padEnd(12)} status=${rc.status} gas=${rc.gasUsed} cost=${cost.toExponential(2)} MON ${note}`);
  for (const l of rc.logs) {
    try {
      const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
      const args = Object.fromEntries(Object.entries(d.args).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : typeof v === 'string' && v.length > 20 ? v.slice(0, 12) + '…' : v]));
      console.log(`     ${d.eventName} ${JSON.stringify(args)}`);
    } catch { /* unrelated log */ }
  }
  return rc;
}

const gasPrice0 = await pub.getGasPrice();
const deployGas = (await pub.estimateGas({ account: account.address, data: bytecode, gasPrice: gasPrice0 })) * 12n / 10n;
const t0 = Date.now();
const dh = await wlt.deployContract({ abi, bytecode, gasPrice: gasPrice0, gas: deployGas });
const drc = await pub.waitForTransactionReceipt({ hash: dh });
const ADDRESS = drc.contractAddress;
console.log(`\nDEPLOYED ${ADDRESS}  status=${drc.status}  gas=${drc.gasUsed}  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
if (drc.status !== 'success') process.exit(1);

const devices = [newDevice(), newDevice(), newDevice()];
console.log('ENROL — this is the Solidity DER-parser test; a bad parse reverts here');
for (const d of devices) {
  const rc = report(await tx(ADDRESS, 'enrol', [d.xHex, d.yHex, attest(d, { counter: 1, opinion: 2, grade: 2 })]), d.id.slice(0, 14));
  if (rc.status !== 'success') { console.error('\nFATAL: Solidity rejected a signature Node accepted -> DER parser bug in enrol()'); process.exit(1); }
}
console.log('  DER parser PASS: contract accepted 3 hardware-shaped P-256 signatures');

console.log('\nNEGATIVE CONTROL (each of these MUST revert)');
try {
  const bad = attest(devices[0], { counter: 9, opinion: 2, grade: 2 });
  bad.derSignature = bad.derSignature.slice(0, 40) + (bad.derSignature[40] === 'f' ? 'e' : 'f') + bad.derSignature.slice(41);
  const r = await tx(ADDRESS, 'enrol', [devices[0].xHex, devices[0].yHex, bad]);
  console.log('  forged signature on enrol:', r.rc.status === 'success' ? 'ACCEPTED — CONTRACT IS BROKEN' : 'reverted, as it must');
} catch (e) { console.log('  forged signature on enrol: reverted before sending,', (e.shortMessage ?? e.message).slice(0, 60)); }

const honest = [
  attest(devices[0], { counter: 2, opinion: 2, grade: 2 }),
  attest(devices[1], { counter: 2, opinion: 1, grade: 1 }),
  attest(devices[2], { counter: 2, opinion: 3, grade: 3 }),
  attest(devices[0], { counter: 3, opinion: 2, grade: 2 }),
  attest(devices[1], { counter: 3, opinion: 2, grade: 2 }),
];
console.log('\nBATCH COMMIT (5 devices-readings, one transaction)');
const rc1 = report(await tx(ADDRESS, 'commitBatch', [honest]));
console.log(`  gas per attestation ≈ ${(rc1.gasUsed - 21000n) / 5n} (each includes one P-256 precompile verify)`);

const replay = attest(devices[0], { counter: 2, opinion: 2, grade: 2 });
const ghost = newDevice();
const unregistered = attest(ghost, { counter: 1, opinion: 0, grade: 0 });
const forged = attest(devices[1], { counter: 4, opinion: 2, grade: 2 });
forged.derSignature = forged.derSignature.slice(0, 40) + (forged.derSignature[40] === 'f' ? 'e' : 'f') + forged.derSignature.slice(41);
const lying = attest(devices[2], { counter: 4, opinion: 3, grade: 0 }); // "excellent" while the device measured the worst grade
const legit = attest(devices[0], { counter: 4, opinion: 2, grade: 2 });

console.log('\nATTACKS (replay, unregistered key, forged signature, confident lie) + one honest reading');
await tx(ADDRESS, 'commitBatch', [replay, unregistered, forged, lying, legit]);

const [accepted, rejected, n] = await Promise.all([
  pub.readContract({ address: ADDRESS, abi, functionName: 'totalAccepted' }),
  pub.readContract({ address: ADDRESS, abi, functionName: 'totalRejected' }),
  pub.getBlockNumber(),
]);
const dev0 = await pub.readContract({ address: ADDRESS, abi, functionName: 'devices', args: [devices[2].id] });
console.log(`\nSTATE  accepted=${accepted} rejected=${rejected} head=${n}`);
console.log(`  device ${devices[2].id.slice(0, 14)}… trust=${dev0[3]} lastCounter=${dev0[2]} revoked=${dev0[4]}`);
console.log(`  -> the device that called a measured-worst reading "excellent" lost trust, onchain.`);
fs.writeFileSync('.address', ADDRESS + '\n');
