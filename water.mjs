#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadState, saveState, DEFAULT_STATE_PATH } from './lib/store.mjs';
import { collectPhases, PHASES } from './lib/source.mjs';
import { reconcileShift } from './lib/reconcile.mjs';
import { inspectRequest, postPortal, reassignOrder, requestTruck } from './lib/portal.mjs';
import { formatReport, formatTrace, formatVillage } from './lib/format.mjs';

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      options[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return { command: positional[0], positional: positional.slice(1), options };
}

function help() {
  return `高地应急供水核对工具

用法:
  node water.mjs collect [--release all|opening|interim|confirmed] [--base URL] [--state FILE]
  node water.mjs report [--village V1] [--as-of confirmed] [--json] [--state FILE]
  node water.mjs handover --village V2 [--json] [--state FILE]
  node water.mjs request --village V3 --litres 23 --key REQ-001 [--phase confirmed]
  node water.mjs request-shortage --village V3 [--litres N] [--key KEY] [--dry-run]
  node water.mjs reassign --order D31 --from V2 --to V3 --litres 23 --key REASSIGN-001 --reason "..."
  node water.mjs inspect --key REQ-001 [--phase confirmed]
  node water.mjs trace D31 [--json]

说明:
  - 缺页(404)或503只记录采集问题，不会删除此前已收到的小票。
  - 小票身份是 班次+村点+村内流水号；不同村的相同流水号不冲突。
  - 同一 --key 重发安全；异报文重用 key 会被调度台/本地状态拒绝。
  - 默认状态文件 ${DEFAULT_STATE_PATH}，可用 --state 或 WATER_STATE 覆盖。
`;
}

function statePath(options) {
  return resolve(options.state ?? process.env.WATER_STATE ?? DEFAULT_STATE_PATH);
}

function resolveShift(state, options) {
  if (options.shift) return options.shift;
  const keys = Object.keys(state.shifts);
  if (keys.length === 1) return keys[0];
  return 'N33';
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help || command === 'help') {
    process.stdout.write(help());
    return;
  }

  const file = statePath(options);
  const state = await loadState(file);
  if (options.base) state.baseUrl = options.base.replace(/\/$/, '');
  if (process.env.SOURCE_URL && !options.base) state.baseUrl = process.env.SOURCE_URL.replace(/\/$/, '');

  if (command === 'collect') {
    const release = options.release ?? 'all';
    const phases = release === 'all' ? PHASES : String(release).split(',').map((x) => x.trim());
    const summaries = await collectPhases(state, phases, { shift: options.shift });
    await saveState(state, file);
    if (options.json) printJson({ stateFile: file, summaries });
    else {
      for (const s of summaries) {
        process.stdout.write(`[${s.phase}/${s.shift}] 取得 ${s.fetched.length} 页；失败 ${s.failed.length} 页\n`);
        for (const f of s.failed) {
          process.stdout.write(`  - ${f.resource}: ${f.status || 'network'} ${f.problem}${s.retainedFromEarlier.includes(f.resource) ? '（已保留此前版本）' : ''}\n`);
        }
      }
      process.stdout.write('状态已保存: ' + file + '\n');
    }
    if (options.strict && summaries.some((s) => s.failed.some((f) => !s.retainedFromEarlier.includes(f.resource)))) {
      process.exitCode = 1;
    }
    return;
  }

  const shift = resolveShift(state, options);
  if (!state.shifts[shift]) {
    throw new Error(`本地没有班次 ${shift}，请先运行 collect`);
  }
  const report = reconcileShift(state, shift, { asOf: options['as-of'] ?? options.asOf ?? 'confirmed' });

  if (command === 'report' || command === 'handover') {
    if (options.village) {
      const v = report.villages.find((x) => x.village === options.village);
      if (!v) throw new Error('未知村点 ' + options.village);
      if (options.json) {
        printJson({ village: v, relatedTransfers: report.transfers, issues: report.issues.filter((i) => (i.affectedVillages ?? []).includes(v.village)) });
      } else {
        process.stdout.write(formatVillage(v) + '\n\n相关转罐段：\n');
        for (const t of report.transfers.filter((t) =>
          [t.source_tank, t.dest_tank].some((tank) => v.routeRemainders.some((r) => r.tank === tank) || v.receipts.some((r) => r.tank === tank)))) {
          process.stdout.write(`  - ${t.ref} ${t.source_tank}→${t.dest_tank} ${t.litres}L [${t.status}]\n`);
        }
        const relatedIssues = report.issues.filter((i) => (i.affectedVillages ?? []).includes(v.village));
        if (relatedIssues.length) {
          process.stdout.write('\n未对上/超差分支：\n');
          for (const i of relatedIssues) process.stdout.write(`  ! ${i.code} ${i.transfer ?? i.ticket ?? i.tank ?? ''} ${i.residualL ?? i.varianceL ?? ''}L\n`);
        }
      }
      return;
    }
    if (options.json) printJson(report);
    else process.stdout.write(formatReport(report) + '\n');
    return;
  }

  if (command === 'request' || command === 'request-shortage') {
    let village = options.village;
    let litres = options.litres === undefined ? undefined : Number(options.litres);
    let key = options.key;
    if (command === 'request-shortage') {
      if (!village) throw new Error('request-shortage 需要 --village');
      const v = report.villages.find((x) => x.village === village);
      if (!v) throw new Error('未知村点 ' + village);
      key ??= options.key ?? `shortage:${shift}:${village}`;
      const existing = state.shifts[shift]?.portalRequests?.[key];
      litres ??= Number(existing?.requestPayload?.facts?.litres) || v.newOrderNeedL;
      if (litres <= 0 && !existing && !options.force) {
        throw new Error(`${village} 没有未被现有车次覆盖的确实短缺；如仍要提交请加 --force --litres`);
      }
    }
    if (!village || !Number.isFinite(litres) || litres <= 0) throw new Error('请提供 --village 和正整数 --litres');
    key ??= options.key;
    if (!key) throw new Error('请提供幂等请求号 --key');
    if (options['dry-run']) {
      printJson({ dryRun: true, action: 'request', key, shift, phase: options.phase ?? 'confirmed', facts: { village, litres, reason: options.reason } });
      return;
    }
    const result = await requestTruck(state, shift, { key, village, litres, reason: options.reason, phase: options.phase ?? 'confirmed' });
    await saveState(state, file);
    if (options.json) printJson(result);
    else process.stdout.write(`请求 ${key}: HTTP ${result.status} ${result.body?.order ?? ''} result=${result.body?.result ?? result.body?.message ?? ''} sourceRef=${result.body?.sourceRef ?? ''}\n状态已保存。\n`);
    return;
  }

  if (command === 'reassign') {
    const order = options.order ?? positional[0];
    const key = options.key;
    const toVillage = options.to;
    const litres = Number(options.litres);
    if (!order || !key || !toVillage || !Number.isFinite(litres) || litres <= 0) {
      throw new Error('reassign 需要 --order --to --litres --key');
    }
    const orderView = report.orders.find((o) => o.order === order);
    const fromVillage = options.from ?? orderView?.village ?? orderView?.allocations?.[0]?.village;
    if (!fromVillage) throw new Error('无法推断原村点，请提供 --from');
    const result = await reassignOrder(state, report, shift, {
      order, key, fromVillage, toVillage, litres, reason: options.reason ?? '', phase: options.phase ?? 'confirmed',
    });
    await saveState(state, file);
    if (options.json) printJson(result);
    else process.stdout.write(`改派 ${order}: HTTP ${result.status} result=${result.body?.result ?? result.body?.message ?? ''} sourceRef=${result.body?.sourceRef ?? ''}\n状态已保存。\n`);
    return;
  }

  if (command === 'inspect') {
    const key = options.key ?? positional[0];
    if (!key) throw new Error('inspect 需要 --key');
    const response = await inspectRequest(state, shift, key, { phase: options.phase ?? 'confirmed' });
    await saveState(state, file);
    if (options.json) printJson(response);
    else process.stdout.write(`HTTP ${response.status}\n` + JSON.stringify(response.body, null, 2) + '\n');
    return;
  }

  if (command === 'trace') {
    const orderId = options.order ?? positional[0];
    if (!orderId) throw new Error('trace 需要派车单号，例如 trace D31');
    const order = report.orders.find((o) => o.order === orderId) ?? null;
    const events = (state.shifts[shift].orderEvents ?? []).filter((e) => e.order === orderId);
    const requests = Object.values(state.shifts[shift].portalRequests ?? {}).filter((r) =>
      r.orderRef === orderId || r.payload?.facts?.order === orderId || r.body?.order === orderId);
    const trace = { orderId, order, events, requests };
    if (options.json) printJson(trace);
    else process.stdout.write(formatTrace(orderId, trace) + '\n');
    return;
  }

  throw new Error('未知命令: ' + command + '\n\n' + help());
}

main().catch((error) => {
  process.stderr.write((error.code ? `[${error.code}] ` : '') + error.message + '\n');
  process.exitCode = error.status === 409 ? 2 : 1;
});
