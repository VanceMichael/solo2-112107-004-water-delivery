import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSource } from '../source.mjs';
import { emptyState, saveState, loadState } from '../lib/store.mjs';
import { collectPhases, SourceClient } from '../lib/source.mjs';
import { reconcileShift } from '../lib/reconcile.mjs';
import { requestTruck, reassignOrder, inspectRequest } from '../lib/portal.mjs';

let server;
let base;

before(async () => {
  server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function collectedState() {
  const state = emptyState(base);
  const client = new SourceClient({ baseUrl: base });
  const summaries = await collectPhases(state, ['opening', 'interim', 'confirmed'], { client });
  return { state, client, summaries };
}

test('反复采集保留缺页前资料，并识别修订', async () => {
  const { state, summaries } = await collectedState();
  const interim = summaries.find((s) => s.phase === 'interim');
  assert.equal(interim.failed.some((f) => f.resource === 'village2-2' && f.status === 503), true);
  assert.equal(interim.retainedFromEarlier.includes('village2-2'), true);

  const interimReport = reconcileShift(state, 'N33', { asOf: 'interim' });
  const v2Interim = interimReport.villages.find((v) => v.village === 'V2');
  assert.equal(v2Interim.confirmedReceivedL, 530); // opening copy survives interim 503.
  const v1Interim = interimReport.villages.find((v) => v.village === 'V1');
  assert.equal(v1Interim.confirmedReceivedL, 500);
  const v3Interim = interimReport.villages.find((v) => v.village === 'V3');
  assert.equal(v3Interim.confirmedReceivedL, 330);

  const report = reconcileShift(state, 'N33');
  assert.equal(report.asOf, 'confirmed');
  const byVillage = Object.fromEntries(report.villages.map((v) => [v.village, v]));

  assert.equal(byVillage.V1.confirmedReceivedL, 600);
  assert.equal(byVillage.V1.gapL, 150);
  assert.equal(byVillage.V1.departedExcessL, 100);
  assert.equal(byVillage.V1.alerts.some((a) => a.code === 'DEPARTED_ORDER_EXCESS_TO_DUTY_OFFICER'), true);

  assert.equal(byVillage.V2.confirmedReceivedL, 530);
  assert.equal(byVillage.V2.gapL, 220);
  assert.equal(byVillage.V2.pendingCoverageL, 20);
  assert.equal(byVillage.V2.knownShortageL, 200);
  assert.equal(byVillage.V2.reassignableAcceptedL, 130);

  assert.equal(byVillage.V3.confirmedReceivedL, 327);
  assert.equal(byVillage.V3.heldReceiptsL, 50);
  assert.equal(byVillage.V3.pendingCoverageL, 50);
  assert.equal(byVillage.V3.knownShortageL, 23);
  assert.equal(byVillage.V3.newOrderNeedL, 23);

  // Village-local serial numbers: both #17 are valid because villages differ.
  const ids = report.villages.flatMap((v) => v.receipts.map((r) => r.id));
  assert.ok(ids.includes('N33/V1#17'));
  assert.ok(ids.includes('N33/V2#17'));
  assert.equal(ids.filter((id) => id.endsWith('#17')).length, 2);

  const x2 = report.transfers.find((t) => t.ref === 'X2');
  assert.equal(x2.status, 'unconfirmed');
  const x3 = report.transfers.find((t) => t.ref === 'X3');
  assert.equal(x3.status, 'rejected_cycle');
  assert.equal(x3.withdrawn, true);

  assert.equal(report.totals.releaseL, 1700);
  assert.equal(report.totals.confirmedReceivedL, 1457);
  for (const d of report.dispatches) assert.equal(d.noDoubleCount, true);
});

test('portal request is idempotent and same key cannot change payload', async () => {
  const { state, client } = await collectedState();
  const input = { key: 'test-request-1', village: 'V3', litres: 23, phase: 'confirmed' };
  const first = await requestTruck(state, 'N33', input, { client });
  assert.equal([200, 201].includes(first.status), true);
  assert.equal(first.body.order, 'D40');
  const sourceRef = first.body.sourceRef;

  const replay = await requestTruck(state, 'N33', input, { client });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.sourceRef, sourceRef);
  assert.equal(state.shifts.N33.portalRequests[input.key].receipts.length >= 2, true);

  const report = reconcileShift(state, 'N33');
  const v3 = report.villages.find((v) => v.village === 'V3');
  assert.equal(v3.orderCoverageL, 23);
  assert.equal(v3.newOrderNeedL, 0);

  await assert.rejects(
    requestTruck(state, 'N33', { ...input, litres: 999 }, { client }),
    (error) => error.code === 'REQUEST_KEY_CONFLICT' || error.status === 409,
  );

  const inspected = await inspectRequest(state, 'N33', input.key, { client, phase: 'confirmed' });
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.sourceRef, sourceRef);
});

test('accepted D31 can be partially reassigned once; departed D32 cannot', async () => {
  const { state, client } = await collectedState();
  let report = reconcileShift(state, 'N33');
  const input = {
    key: 'test-reassign-d31', order: 'D31', fromVillage: 'V2', toVillage: 'V3', litres: 23,
    reason: 'V2 extra ticket and V3 known uncovered', phase: 'confirmed',
  };
  const first = await reassignOrder(state, report, 'N33', input, { client });
  assert.equal([200, 201].includes(first.status), true);
  const replay = await reassignOrder(state, report, 'N33', input, { client });
  assert.equal(replay.status, 200);
  assert.equal(state.shifts.N33.orderEvents.filter((e) => e.key === input.key).length, 1);

  report = reconcileShift(state, 'N33');
  const d31 = report.orders.find((o) => o.order === 'D31');
  assert.equal(d31.allocations.find((a) => a.village === 'V2').litres, 327);
  assert.equal(d31.allocations.find((a) => a.village === 'V3').litres, 23);
  const v3 = report.villages.find((v) => v.village === 'V3');
  assert.equal(v3.orderCoverageL, 23);

  await assert.rejects(
    reassignOrder(state, report, 'N33', { ...input, key: 'departed-should-fail', order: 'D32' }, { client }),
    /已出车/,
  );
});

test('state survives restart and can be reloaded', async () => {
  const { state, client } = await collectedState();
  await requestTruck(state, 'N33', { key: 'persist-1', village: 'V3', litres: 23 }, { client });
  const dir = await mkdtemp(join(tmpdir(), 'water-'));
  const file = join(dir, 'state.json');
  await saveState(state, file);
  const loaded = await loadState(file);
  assert.equal(loaded.shifts.N33.portalRequests['persist-1'].orderRef, 'D40');
  const text = await readFile(file, 'utf8');
  assert.match(text, /persist-1/);
  const report = reconcileShift(loaded, 'N33');
  assert.equal(report.villages.find((v) => v.village === 'V3').orderCoverageL, 23);
});
