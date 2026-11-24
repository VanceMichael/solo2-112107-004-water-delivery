import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSource } from '../source.mjs';

const cli = new URL('../water.mjs', import.meta.url).pathname;
function run(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { cwd: new URL('..', import.meta.url).pathname }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

let server;
let base;
let dir;
let stateFile;

before(async () => {
  server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  dir = await mkdtemp(join(tmpdir(), 'water-cli-'));
  stateFile = join(dir, 'state.json');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('CLI collects, reports, idempotently requests, and blocks departed reassignment', async () => {
  const collect = await run(['collect', '--base', base, '--state', stateFile, '--release', 'all']);
  assert.match(collect.stdout, /village2-2.*503/);

  const reportRun = await run(['report', '--state', stateFile, '--json']);
  const report = JSON.parse(reportRun.stdout);
  const v3 = report.villages.find((v) => v.village === 'V3');
  assert.equal(v3.knownShortageL, 23);
  assert.equal(v3.newOrderNeedL, 23);

  const args = ['request-shortage', '--state', stateFile, '--village', 'V3', '--key', 'CLI-E2E-1', '--phase', 'confirmed'];
  const first = await run(args);
  assert.match(first.stdout, /HTTP 201 D40/);
  const second = await run(args);
  assert.match(second.stdout, /HTTP 200 D40/);

  const after = JSON.parse((await run(['report', '--state', stateFile, '--json'])).stdout);
  assert.equal(after.villages.find((v) => v.village === 'V3').orderCoverageL, 23);

  await assert.rejects(
    run(['reassign', '--state', stateFile, '--order', 'D32', '--to', 'V3', '--litres', '100', '--key', 'CLI-NO-DEPARTED']),
    /已出车/,
  );
});
