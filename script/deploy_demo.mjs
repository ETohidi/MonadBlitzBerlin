// Deploys GroundTruth to Monad testnet and drives the full claim end to end,
// attacks included, so the stage demo is rehearsed against a real chain.
import fs from 'node:fs';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, decodeEventLog,
  getContractAddress, keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newDevice, attest } from '../lib/attest.mjs';

const RPC = process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = 10143;
const monadTestnet = {
  id: CHAIN_ID, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// retryCount 0: an automatic resend would pick a fresh nonce and double-spend gas.
// We re-broadcast the *identical* signed payload ourselves instead.
const rpc = http(RPC, { timeout: 45_000, retryCount: 0 });

if (!process.env.SPONSOR_PRIVATE_KEY) { console.error('SPONSOR_PRIVATE_KEY missing'); process.exit(1); }
const account = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY);
const pub = createPublicClient({ chain: monadTestnet, transport: rpc });
const wlt = createWalletClient({ account, chain: monadTestnet, transport: rpc });

const abi = JSON.parse(fs.readFileSync(process.cwd() + '/out/GroundTruth.abi.json', 'utf8'));
const bytecode = '0x' + fs.readFileSync(process.cwd() + '/out/GroundTruth.bin', 'utf8').trim();
const runtime = '0x' + fs.readFileSync(process.cwd() + '/out/GroundTruth.deployed.bin', 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = async (a) => (await pub.getCode({ address: a }));
// Comparing the *deployed* code (not the creation bytecode, which carries a constructor
// wrapper) tells a previous deployment of this exact build apart from a stale one.
const isThisContract = async (a) => ((await codeOf(a)) ?? '').toLowerCase() === runtime.toLowerCase();

const bal = await pub.getBalance({ address: account.address });
console.log(`sponsor ${account.address}\n  balance ${(Number(bal) / 1e18).toFixed(4)} MON`);
if (bal < 10n ** 16n) { console.error('  -> not enough testnet MON'); process.exit(1); }

let nonce = Number(await pub.getTransactionCount({ address: account.address, blockTag: 'pending' }));

// Sign first, then broadcast: signing gives us the tx hash up front, so a timed-out
// POST is a question about the network, never a question about whether the tx escaped.
async function broadcast(serialized) {
  const hash = keccak256(serialized);
  for (let i = 0; i < 6; i++) {
    try { await pub.sendRawTransaction({ serializedTransaction: serialized }); return hash; }
    catch (e) {
      const m = e.shortMessage ?? e.message ?? '';
      // the first attempt did land — that's not an error, that's a duplicate
      if (/already (known|imported)|nonce too low|known transaction/i.test(m)) return hash;
      if (i === 5) throw e;
      console.log(`  broadcast retry ${i + 1}: ${m.slice(0, 60)}`);
    }
    await sleep(2000);
  }
}

async function tx(to, functionName, args) {
  const gasPrice = await pub.getGasPrice();
  const data = encodeFunctionData({ abi, functionName, args });
  let gas = 5_000_000n;
  try { gas = (await pub.estimateGas({ account: account.address, to, data, gasPrice })) * 12n / 10n; }
  catch (e) { console.log(`  estimate failed for ${functionName}: ${(e.shortMessage ?? e.message).slice(0, 70)}`); }
  const serialized = await wlt.signTransaction({ account, chain: monadTestnet, to, data, gasPrice, gas, nonce });
  const hash = await broadcast(serialized);
  nonce++;
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 300_000 });
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

// ---- deploy -----------------------------------------------------------------
// A previous run may already have deployed even though its HTTP request timed out:
// a CREATE address is a pure function of (sender, nonce), so re-derive and look.
const gasPrice0 = await pub.getGasPrice();
let ADDRESS = null;
const saved = fs.existsSync('.address') ? fs.readFileSync('.address', 'utf8').trim() : '';
if (saved && await isThisContract(saved).catch(() => false)) {
  ADDRESS = saved;
  console.log(`\nREUSE ${ADDRESS}  (this build is already live, skipping deploy)`);
} else {
  let found = null;
  for (let k = nonce; k-- > Math.max(0, nonce - 5) && !found; ) {
    const a = getContractAddress({ from: account.address, nonce: k });
    if (await isThisContract(a)) found = { a, k };
  }
  if (found) {
    ADDRESS = found.a;
    console.log(`\nRECOVERED ${ADDRESS}  (this build deployed by an earlier run at nonce ${found.k})`);
  } else {
    const expected = getContractAddress({ from: account.address, nonce });
    const deployGas = (await pub.estimateGas({ account: account.address, data: bytecode, gasPrice: gasPrice0 })) * 12n / 10n;
    console.log(`\nDEPLOY  nonce=${nonce} gas=${deployGas} -> ${expected}`);
    const t0 = Date.now();
    const serialized = await wlt.signTransaction({ account, chain: monadTestnet, data: bytecode, gasPrice: gasPrice0, gas: deployGas, nonce });
    await broadcast(serialized);
    nonce++;
    for (let i = 0; i < 60 && !(await isThisContract(expected)); i++) await sleep(2000);
    if (!(await isThisContract(expected))) { console.error('  deploy never landed'); process.exit(1); }
    ADDRESS = expected;
    fs.writeFileSync('.address', ADDRESS + '\n');
    console.log(`  live after ${((Date.now() - t0) / 1000).toFixed(1)}s  (address saved to .address)`);
  }
}
fs.writeFileSync('.address', ADDRESS + '\n');
console.log(`CONTRACT ${ADDRESS}\n`);

const CELL0 = '0x' + '00'.repeat(32);
const read = (functionName, args) => pub.readContract({ address: ADDRESS, abi, functionName, args });
const base = {
  accepted: await read('totalAccepted'),
  rejected: await read('totalRejected'),
  devices: await read('deviceCount'),
  cell: await read('cells', [CELL0]),
};

const devices = [newDevice(), newDevice(), newDevice()];
console.log('ENROL — this is the Solidity DER-parser test; a bad parse reverts here');
for (const d of devices) {
  const rc = report(await tx(ADDRESS, 'enrol', [d.xHex, d.yHex, attest(d, { counter: 1, opinion: 2, grade: 2 })]), d.id.slice(0, 14));
  if (rc.status !== 'success') { console.error('\nFATAL: Solidity rejected a signature Node accepted -> DER parser bug in enrol()'); process.exit(1); }
}
console.log('  DER parser PASS: contract accepted 3 hardware-shaped P-256 signatures');

console.log('\nNEGATIVE CONTROL (this MUST fail)');
try {
  const bad = attest(devices[0], { counter: 9, opinion: 2, grade: 2 });
  bad.derSignature = bad.derSignature.slice(0, 40) + (bad.derSignature[40] === 'f' ? 'e' : 'f') + bad.derSignature.slice(41);
  const r = await tx(ADDRESS, 'enrol', [devices[0].xHex, devices[0].yHex, bad]);
  console.log('  forged signature on enrol:', r.rc.status === 'success' ? 'ACCEPTED — CONTRACT IS BROKEN' : 'reverted, as it must');
} catch (e) { console.log('  forged signature on enrol: refused before sending,', (e.shortMessage ?? e.message).slice(0, 60)); }

const honest = [
  attest(devices[0], { counter: 2, opinion: 2, grade: 2 }),
  attest(devices[1], { counter: 2, opinion: 1, grade: 1 }),
  attest(devices[2], { counter: 2, opinion: 3, grade: 3 }),
  attest(devices[0], { counter: 3, opinion: 2, grade: 2 }),
  attest(devices[1], { counter: 3, opinion: 2, grade: 2 }),
];
console.log('\nBATCH COMMIT (5 device-readings, one transaction)');
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
report(await tx(ADDRESS, 'commitBatch', [[replay, unregistered, forged, lying, legit]]));

const accepted = await read('totalAccepted');
const rejected = await read('totalRejected');
const n = await pub.getBlockNumber();
const dev2 = await read('devices', [devices[2].id]);
const cell = await read('cells', [CELL0]);
const dAcc = Number(accepted - base.accepted);
const dRej = Number(rejected - base.rejected);
console.log(`\nSTATE  accepted +${dAcc}  rejected +${dRej}  devices +${Number(await read('deviceCount') - base.devices)}  head=${n}`);
console.log(`  device ${devices[2].id.slice(0, 14)}… trust=${dev2[3]} lastCounter=${dev2[2]} revoked=${dev2[4]}`);
console.log(`  -> the device that called a measured-worst reading "excellent" lost trust, onchain.`);
console.log(`\nCELL ${CELL0.slice(0, 10)}… (the map is chain state, not an indexer's cache)`);
console.log(`  n=${Number(cell[0] - base.cell[0])} gradeSum=${Number(cell[1] - base.cell[1])} opinionSum=${Number(cell[2] - base.cell[2])} worst=${cell[3]}`);

// 5 honest + 2 accepted from the attack batch; 3 refusals; grades 2,1,3,2,2,0,2
const checks = [
  ['accepted delta', dAcc, 7],
  ['rejected delta', dRej, 3],
  ['cell count delta', Number(cell[0] - base.cell[0]), 7],
  ['cell gradeSum delta', Number(cell[1] - base.cell[1]), 12],
  ['cell opinionSum delta', Number(cell[2] - base.cell[2]), 15],
  ['cell worst grade', Number(cell[3]), 0],
  ['liar trust below honest floor', Number(dev2[3]) < 1000 ? 1 : 0, 1],
];
const bad = checks.filter(([, got, want]) => got !== want);
for (const [name, got, want] of checks) console.log(`  ${got === want ? 'PASS' : 'FAIL'}  ${name}: ${got}${got === want ? '' : ' expected ' + want}`);
if (bad.length) { console.error(`\n${bad.length} assertion(s) failed`); process.exit(1); }
console.log('\nALL ASSERTIONS PASSED — the whole claim ran against a real chain in one contract.');
