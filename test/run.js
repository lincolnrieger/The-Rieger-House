// Runs the API tests against a real `wrangler dev` with a throwaway local D1 database.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-d1-'));
const port = 8700 + Math.floor(Math.random() * 200);

const migrate = spawnSync(wrangler, ['d1', 'migrations', 'apply', 'rieger-house', '--local', '--persist-to', persist], {
  cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' },
});
if (migrate.status !== 0) {
  console.error(migrate.stdout, migrate.stderr);
  process.exit(1);
}

const dev = spawn(wrangler, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'SETUP_CODE:424242', '--show-interactive-dev-session=false'], {
  cwd: root, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));

const cleanup = () => {
  dev.kill();
  fs.rmSync(persist, { recursive: true, force: true });
};

(async () => {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + '/api/bootstrap')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    if (i === 119) {
      console.error('wrangler dev did not start:\n' + log);
      cleanup();
      process.exit(1);
    }
  }
  const t = spawnSync(process.execPath, ['--test', path.join(__dirname, 'api.test.js')], {
    stdio: 'inherit', env: { ...process.env, BASE_URL: base },
  });
  cleanup();
  process.exit(t.status);
})();
