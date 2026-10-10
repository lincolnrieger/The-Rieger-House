'use strict';

// Usage: npm run reset-pin -- <name> <new PIN>
// For when someone (usually the admin) forgets their PIN. Run it on the server.
const path = require('node:path');
const { open } = require('./db');
const { hashPin } = require('./server');

const [name, pin] = process.argv.slice(2);
if (!name || !/^\d{4,8}$/.test(pin || '')) {
  console.error('Usage: npm run reset-pin -- <name> <new PIN, 4 to 8 digits>');
  process.exit(1);
}
const db = open(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const user = db.prepare('SELECT * FROM users WHERE active = 1 AND name = ? COLLATE NOCASE').get(name);
if (!user) {
  console.error(`No one called "${name}".`);
  process.exit(1);
}
if (user.role === 'admin' && pin.length < 6) {
  console.error('The admin PIN needs at least 6 digits.');
  process.exit(1);
}
db.prepare('UPDATE users SET pin_hash = ?, failed_logins = 0, locked_until = 0 WHERE id = ?').run(hashPin(pin), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`${user.name}'s PIN has been reset.`);
