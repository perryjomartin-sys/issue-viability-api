import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
// Force TAP so the total is independent of terminals and Node's default reporter.
const run = spawnSync('npm', ['test'], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
const count = run.stdout?.match(/^# tests (\d+)$/m)?.[1];
const passed = run.stdout?.match(/^# pass (\d+)$/m)?.[1];
if (run.error || run.status !== 0 || !count || Number(count) === 0 || passed !== count) {
  console.error('Full test suite/report: FAIL');
  process.exitCode = 1;
} else {
  console.log(`Full test suite: PASS (${count} tests)`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${count}\n`);
}
