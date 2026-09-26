import fs from 'node:fs';
import solc from 'solc';

const path = process.argv[2] ?? 'contracts/GroundTruth.sol';
const name = path.split('/').pop();
const input = {
  language: 'Solidity',
  sources: { [name]: { content: fs.readFileSync(path, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.gasEstimates', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = out.errors ?? [];
errors.filter((e) => e.severity === 'error').forEach((e) => console.log(e.formattedMessage));
const warnings = errors.filter((e) => e.severity !== 'error');
console.log(`errors: ${errors.filter((e) => e.severity === 'error').length}  warnings: ${warnings.length}`);
if (warnings.length) console.log(warnings.map((w) => ' - ' + w.message).join('\n'));

for (const [file, contracts] of Object.entries(out.contracts ?? {})) {
  for (const [cname, c] of Object.entries(contracts)) {
    fs.writeFileSync(`out/${file}:${cname}.abi.json`, JSON.stringify(c.abi, null, 2));
    fs.writeFileSync(`out/${file}:${cname}.bin`, c.evm.bytecode.object);
    console.log(`OK ${cname}  bytecode ${(c.evm.bytecode.object.length - 2) / 2} bytes  deploy gas ${c.evm.gasEstimates.creation.total}`);
    console.log('   ' + c.abi.filter((x) => x.type === 'function').map((f) => f.name).join(', '));
  }
}
