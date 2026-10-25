const readline = require('readline');

const SECRET = 'SNG@PoultryFarm#2024!DevInfantary';

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).toUpperCase();
  return hex.padStart(8, '0');
}

function generateCode(machineId, cycle) {
  const combined = machineId + cycle + SECRET;
  const hash = hashCode(combined);
  return `DIP-${hash.slice(0, 4)}-${hash.slice(4, 8)}`;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Enter Machine ID: ', (machineId) => {
  rl.question('Enter Cycle Number (0 for first-time, then 1, 2, 3...): ', (cycleInput) => {
    const cycle = parseInt(cycleInput.trim(), 10) || 0;
    const code = generateCode(machineId.trim(), cycle);
    console.log('\n✅ Activation Code:', code);
    console.log('   (Valid for cycle ' + cycle + ' only — one-time use)');
    console.log('\nSend this code to the client.\n');
    rl.close();
  });
});