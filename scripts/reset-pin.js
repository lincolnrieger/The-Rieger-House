// Usage: npm run reset-pin -- <name> <new PIN> [--local]
// For when someone (usually the admin) forgets their PIN. Updates the D1 database
// directly with Wrangler, so you need to be logged in with `npx wrangler login`.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { hashPin } = require('./pin-hash');

(async () => {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const [name, pin] = args.filter((a) => a !== '--local');
  if (!name || !/^\d{4,8}$/.test(pin || '')) {
    console.error('Usage: npm run reset-pin -- <name> <new PIN, 4 to 8 digits> [--local]');
    process.exit(1);
  }
  const hash = await hashPin(pin);
  const safeName = name.replace(/'/g, "''");
  // Admin PINs must be at least 6 digits; the WHERE clause refuses shorter ones for admins.
  const sql = `
    DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE active = 1 AND name = '${safeName}' COLLATE NOCASE);
    UPDATE users SET pin_hash = '${hash}', failed_logins = 0, locked_until = 0
      WHERE active = 1 AND name = '${safeName}' COLLATE NOCASE AND (role <> 'admin' OR ${pin.length} >= 6);
    SELECT name, role, CASE WHEN pin_hash = '${hash}' THEN 'PIN reset' ELSE 'NOT changed (admin PINs need 6+ digits)' END AS result
      FROM users WHERE active = 1 AND name = '${safeName}' COLLATE NOCASE;`;
  const wrangler = path.join(__dirname, '..', 'node_modules', '.bin', 'wrangler');
  const r = spawnSync(wrangler, ['d1', 'execute', 'rieger-house', local ? '--local' : '--remote', '--command', sql], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
})();
