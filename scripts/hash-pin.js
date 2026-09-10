const bcrypt = require('bcryptjs');

const pin = process.argv[2];
if (!pin) {
  console.error('Usage: node scripts/hash-pin.js <pin>');
  process.exit(1);
}

console.log(bcrypt.hashSync(pin, 10));
