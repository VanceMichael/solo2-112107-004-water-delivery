const fmt = (n) => `${n}L`;

export function formatVillage(v) {
  const lines = [];
  lines.push(`■ ${v.village}  目标 ${fmt(v.targetL)}  可确认已收 ${fmt(v.confirmedReceivedL)}  目标差 ${fmt(v.gapL)}`);
  lines.push(`  待计量/凭证确认：${fmt(v.pendingCoverageL)}（已知待核凭证 ${fmt(v.pendingKnownL)}，缺页 ${v.missingPages.length ? v.missingPages.join(',') : '无'}）`);
  lines.push(`  确实短缺：${fmt(v.knownShortageL)}  现有车次占量：${fmt(v.orderCoverageL)}  尚需新请求：${fmt(v.newOrderNeedL)}`);

  if (v.receipts.length) {
    lines.push('  小票：');
    for (const r of v.receipts) {
      const flag = r.admitted ? '承认' : '待查';
      const rev = r.revisionVarianceL ? `，修订差 ${r.revisionVarianceL}L/${r.withinMeasurementTolerance ? '契约内' : '超差'}` : '';
      lines.push(`    - [${flag}] ${r.id} ${fmt(r.litres)} ${r.time ?? ''} 罐 ${r.tank}${rev}${r.reasons.length ? '；原因：' + r.reasons.join('；') : ''}`);
    }
  }

  if (v.pendingItems.length) {
    lines.push('  待查覆盖项：');
    for (const p of v.pendingItems) lines.push(`    * ${p.kind} ${fmt(p.amountL)} ${p.detail ?? p.sourceRefs?.join(',') ?? ''}`);
  }

  if (v.orders.length) {
    lines.push('  补车/派车单：');
    for (const o of v.orders) {
      const alloc = o.allocations.map((a) => `${a.village}:${fmt(a.litres)}`).join(' ');
      const keys = [...new Set([o.requestKey, ...o.allocations.map((a) => a.requestKey)].filter(Boolean))];
      const reasons = o.allocations.map((a) => a.reason).filter(Boolean);
      lines.push(`    - ${o.order} [${o.status}] ${alloc}${keys.length ? ' 请求=' + keys.join(',') : ''}${o.sourceRef ? ' 回执=' + o.sourceRef : ''}`);
      for (const reason of reasons) lines.push(`      改派原因：${reason}`);
    }
  }
  if (v.departedExcessL > 0) lines.push(`  ⚠ 已出车超额 ${fmt(v.departedExcessL)}，必须交值班员，不能改派`);
  if (v.reassignableAcceptedL > 0) lines.push(`  ↻ 已受理未出车，确定可改派余量 ${fmt(v.reassignableAcceptedL)}`);
  if (v.networkRemainderL > 0) lines.push(`  … 路线罐内账面余量 ${fmt(v.networkRemainderL)}（未作为已收，也不默认抵消补车）：${v.routeRemainders.map((x) => `${x.tank}=${x.litres}L`).join(', ')}`);
  return lines.join('\n');
}

export function formatReport(report) {
  const lines = [`班次 ${report.shift} / 视图 ${report.asOf} / 计量容差 ${report.toleranceL}L`, ''];
  for (const v of report.villages) lines.push(formatVillage(v), '');

  lines.push('转罐记录：');
  for (const t of report.transfers) {
    const rec = t.reconciliation ? `；下游对账余 ${t.reconciliation.residualL}L` : '';
    lines.push(`  - ${t.ref} ${t.source_tank}→${t.dest_tank} ${fmt(t.litres)} [${t.status}] 双签=${t.from_signed && t.to_signed}${rec}${t.issues.length ? '；' + t.issues.join('；') : ''}`);
  }

  if (report.issues.length) {
    lines.push('', '需人工/圈定分支：');
    for (const i of report.issues) {
      lines.push(`  ! ${i.code} ${i.transfer ? i.transfer + ' ' : ''}${i.village ? i.village + ' ' : ''}${i.tank ? i.tank + ' ' : ''}${i.residualL != null ? '差异/余量=' + i.residualL + 'L ' : ''}影响村点=${(i.affectedVillages ?? []).join('/') || '未映射'}`);
    }
  }

  lines.push('', '放行量守恒（不把放行量当作村点收货）：');
  for (const d of report.dispatches) {
    lines.push(`  - ${d.dispatch} 放行${fmt(d.releaseL)}，已承认收水${fmt(d.admittedReceiptsL)}，归属余量${fmt(d.ownershipRemainingL)}，罐余额合计${fmt(d.tankBalanceL)}，守恒=${d.noDoubleCount ? '是' : '否'}`);
  }

  lines.push('', `合计：目标${fmt(report.totals.targetL)}，已确认${fmt(report.totals.confirmedReceivedL)}，待查覆盖${fmt(report.totals.pendingCoverageL)}，确实短缺${fmt(report.totals.knownShortageL)}，净新请求${fmt(report.totals.newOrderNeedL)}`);
  return lines.join('\n');
}

export function formatTrace(orderId, trace) {
  const lines = [`派车单 ${orderId} 追溯`];
  if (trace.order) {
    lines.push(`当前来源状态：${trace.order.status}，数量 ${trace.order.litres ?? trace.order.requestedL}L，村点 ${trace.order.village}`);
  }
  if (!trace.events.length) lines.push('暂无改派事件');
  for (const e of trace.events) {
    lines.push(`- ${e.at} 请求${e.key} 回执${e.sourceRef ?? '未取得'}：${e.action} ${e.order} ${e.fromVillage}→${e.toVillage} ${e.acceptedL ?? e.litres}L；原因：${e.reason || '未填写'}`);
  }
  for (const r of trace.requests) {
    lines.push(`- 门户请求 ${r.key} action=${r.action} order=${r.orderRef ?? ''} sourceRef=${r.sourceRef ?? ''} status=${r.status ?? ''} http=${r.lastHttpStatus ?? ''}`);
  }
  return lines.join('\n');
}
