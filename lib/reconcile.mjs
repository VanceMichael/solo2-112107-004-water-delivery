export const TOLERANCE_L = 3;

export function shiftMinutes(time) {
  if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) return Number.MAX_SAFE_INTEGER;
  let [h, m] = time.split(':').map(Number);
  if (h < 12) h += 24; // N33 runs 21:00 through 05:00.
  return h * 60 + m;
}

export function ticketIdentity(ticket, fallbackShift = 'N33') {
  const shift = ticket.shift ?? fallbackShift;
  return `${shift}/${ticket.village}#${ticket.ticket}`;
}

export function difference(a, b) {
  return Math.abs(Number(a ?? 0) - Number(b ?? 0));
}

function bundleFor(shiftState, asOf) {
  const rank = (phase) => ['opening', 'interim', 'confirmed'].indexOf(phase);
  const maxRank = rank(asOf);
  const bundle = {};
  for (const [name, resource] of Object.entries(shiftState.resources ?? {})) {
    const eligible = resource.versions.filter((v) => rank(v.phase) <= maxRank);
    const chosen = eligible[eligible.length - 1];
    if (chosen) bundle[name] = chosen.data;
  }
  return bundle;
}

function historyByTicket(shiftState, asOf) {
  const rank = (phase) => ['opening', 'interim', 'confirmed'].indexOf(phase);
  const maxRank = rank(asOf);
  const history = new Map();
  for (const [page, resource] of Object.entries(shiftState.resources ?? {})) {
    for (const version of resource.versions.filter((v) => rank(v.phase) <= maxRank)) {
      if (!Array.isArray(version.data)) continue;
      for (const row of version.data) {
        if (row?.ticket == null || !row?.village) continue;
        const id = ticketIdentity(row);
        const entries = history.get(id) ?? [];
        entries.push({ phase: version.phase, page, at: version.at, litres: row.litres, row });
        history.set(id, entries);
      }
    }
  }
  return history;
}

function createsCycle(edges, source, dest) {
  if (source === dest) return true;
  const adjacency = new Map();
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push(b);
  }
  const stack = [dest];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (node === source) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}

function sum(items, key) {
  return items.reduce((n, x) => n + (Number(x?.[key]) || 0), 0);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildOrderViews(shiftState, bundle) {
  const sourceOrders = asArray(bundle.orders).map((o) => ({ ...o, origin: 'source' }));
  const localRequestOrders = [];
  for (const req of Object.values(shiftState.portalRequests ?? {})) {
    if (req.action !== 'request' || req.status !== 'accepted' || !req.orderRef) continue;
    const facts = req.facts ?? req.requestPayload?.facts ?? {};
    if (sourceOrders.some((o) => o.order === req.orderRef)) continue;
    localRequestOrders.push({
      order: req.orderRef,
      village: facts.village,
      litres: req.acceptedL ?? req.requestedL ?? 0,
      status: req.receipt?.result ?? req.result ?? 'accepted',
      origin: 'portal-request',
      requestKey: req.key,
      sourceRef: req.sourceRef,
    });
  }

  const byOrder = new Map();
  for (const order of [...sourceOrders, ...localRequestOrders]) {
    const activeStatus = order.status === 'accepted' || order.status === 'departed' || order.status === 'confirmed';
    const acceptedL = Number(order.acceptedL ?? (activeStatus ? order.litres : 0)) || 0;
    byOrder.set(order.order, {
      ...order,
      requestedL: order.litres,
      acceptedL,
      allocations: [{ village: order.village, litres: acceptedL, requestKey: order.requestKey ?? null }],
      events: [],
    });
  }

  for (const event of [...(shiftState.orderEvents ?? [])].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const order = byOrder.get(event.order);
    if (!order) continue;
    order.events.push(event);
    if (event.applied === false || event.status !== 'accepted') continue;
    const qty = Number(event.acceptedL ?? event.litres ?? 0);
    if (!qty) continue;
    const from = order.allocations.find((a) => a.village === event.fromVillage);
    if (from) from.litres = Math.max(0, from.litres - qty);
    order.allocations.push({
      village: event.toVillage,
      litres: qty,
      requestKey: event.key,
      reason: event.reason,
      reassignedFrom: event.fromVillage,
    });
  }

  for (const order of byOrder.values()) {
    order.allocations = order.allocations.filter((a) => a.litres > 0);
  }
  return [...byOrder.values()];
}

/**
 * Reconcile all evidence for one shift. The function is pure with respect to
 * its arguments and never treats a missing/failed page as zero receipts.
 */
export function reconcileShift(state, shiftId, options = {}) {
  const shiftState = state.shifts?.[shiftId];
  if (!shiftState) throw new Error('本地状态中没有班次 ' + shiftId);
  const asOf = options.asOf ?? 'confirmed';
  const toleranceL = options.toleranceL ?? TOLERANCE_L;
  const bundle = bundleFor(shiftState, asOf);
  const ticketHistory = historyByTicket(shiftState, asOf);
  const issues = [];
  const addIssue = (issue) => issues.push({ severity: 'manual', shift: shiftId, ...issue });

  const targets = asArray(bundle.targets);
  const targetByVillage = new Map(targets.map((t) => [t.village, t.litres]));
  const villageIndex = asArray(bundle.villages);
  const villages = villageIndex.map((v) => v.id);
  for (const t of targets) if (!villages.includes(t.village)) villages.push(t.village);

  const plantIndex = bundle['plant-index'] ?? {};
  const dispatchPages = asArray(plantIndex.pages);
  const dispatchRows = dispatchPages.flatMap((p) => asArray(bundle[p]));
  const dispatchById = new Map();
  for (const row of dispatchRows) {
    if (!row?.dispatch) continue;
    const old = dispatchById.get(row.dispatch);
    if (!old) dispatchById.set(row.dispatch, { ...row });
    else if (Number(old.litres) !== Number(row.litres)) {
      addIssue({ code: 'DISPATCH_REVISION_CONFLICT', dispatch: row.dispatch, litres: [old.litres, row.litres] });
    }
  }

  const routes = asArray(bundle.routes);
  const routeByTank = new Map();
  for (const route of routes) {
    const existing = routeByTank.get(route.tank);
    if (!existing) routeByTank.set(route.tank, { ...route, possible_villages: [...(route.possible_villages ?? [])] });
    else for (const v of route.possible_villages ?? []) if (!existing.possible_villages.includes(v)) existing.possible_villages.push(v);
  }

  // Current tickets, with composite village/shift/serial identity.
  const currentPages = villageIndex.flatMap((v) => (v.pages ?? []).map((page) => ({ village: v.id, page })));
  const ticketGroups = new Map();
  const missingPages = [];
  for (const { village, page } of currentPages) {
    if (!bundle[page]) {
      missingPages.push({ village, page, lastChecks: shiftState.resources[page]?.checks?.filter((c) => c.phase === asOf) ?? [] });
      addIssue({ code: 'VILLAGE_PAGE_UNAVAILABLE', village, page, affectedVillages: [village] });
      continue;
    }
    for (const row of asArray(bundle[page])) {
      const ticket = { ...row, village: row.village ?? village, _page: page };
      const id = ticketIdentity(ticket, shiftId);
      const group = ticketGroups.get(id) ?? { id, variants: [], pages: new Set() };
      group.variants.push(ticket);
      group.pages.add(page);
      ticketGroups.set(id, group);
    }
  }

  const unconfirmedIncoming = new Map();
  const allTransferRecords = new Map();
  for (const resource of Object.values(shiftState.resources ?? {})) {
    if (resource.resource !== 'transfer') continue;
    const eligible = resource.versions.filter((v) => ['opening', 'interim', 'confirmed'].indexOf(v.phase) <= ['opening', 'interim', 'confirmed'].indexOf(asOf));
    for (const version of eligible) {
      for (const tr of asArray(version.data)) {
        if (!tr?.ref) continue;
        const rec = allTransferRecords.get(tr.ref) ?? { ...tr, seenPhases: [], versions: [] };
        rec.versions.push({ phase: version.phase, ...tr });
        if (!rec.seenPhases.includes(version.phase)) rec.seenPhases.push(version.phase);
        Object.assign(rec, tr);
        allTransferRecords.set(tr.ref, rec);
      }
    }
  }
  const currentTransferRefs = new Set(asArray(bundle.transfer).map((t) => t.ref));
  for (const tr of allTransferRecords.values()) {
    tr.withdrawn = !currentTransferRefs.has(tr.ref);
    if (!(tr.from_signed && tr.to_signed)) {
      const list = unconfirmedIncoming.get(tr.dest_tank) ?? [];
      list.push(tr.ref);
      unconfirmedIncoming.set(tr.dest_tank, list);
    }
  }

  const receipts = [];
  for (const group of ticketGroups.values()) {
    const uniqueVariants = [];
    for (const v of group.variants) {
      if (!uniqueVariants.some((u) => JSON.stringify(u) === JSON.stringify(v))) uniqueVariants.push(v);
    }
    const current = uniqueVariants.at(-1);
    const id = group.id;
    const history = ticketHistory.get(id) ?? [];
    const litreValues = [...new Set(history.map((h) => h.litres))];
    const maxRevisionDiff = litreValues.length ? Math.max(...litreValues) - Math.min(...litreValues) : 0;
    const reasons = [];
    let status = 'admitted';

    if (current.shift && current.shift !== shiftId) {
      status = 'held';
      reasons.push('wrong_shift');
    }
    const route = routeByTank.get(current.tank);
    if (!route) {
      status = 'held';
      reasons.push('unknown_tank_route');
    } else if (!route.possible_villages.includes(current.village)) {
      status = 'held';
      reasons.push('route_village_mismatch');
    }
    if (unconfirmedIncoming.has(current.tank)) {
      status = 'held';
      reasons.push('destination_transfer_not_dual_signed:' + unconfirmedIncoming.get(current.tank).join(','));
    }
    if (uniqueVariants.length > 1 && new Set(uniqueVariants.map((v) => v.litres)).size > 1) {
      status = 'held';
      reasons.push('conflicting_current_duplicate');
    }
    if (maxRevisionDiff > toleranceL) {
      status = 'held_measurement';
      reasons.push(`revision_variance_${maxRevisionDiff}L_exceeds_${toleranceL}L`);
      addIssue({
        code: 'TICKET_MEASUREMENT_VARIANCE_EXCEEDED',
        ticket: current.ticket,
        ticketId: id,
        village: current.village,
        tank: current.tank,
        dispatch: route?.dispatch,
        affectedVillages: [current.village],
        affectedBranches: [{ dispatch: route?.dispatch, tank: current.tank, village: current.village, ticket: current.ticket }],
        varianceL: maxRevisionDiff,
        toleranceL,
        valuesL: litreValues,
      });
    }

    const receipt = {
      id,
      ticket: current.ticket,
      shift: current.shift ?? shiftId,
      village: current.village,
      tank: current.tank,
      dispatch: route?.dispatch ?? null,
      litres: current.litres,
      time: current.time,
      page: current._page,
      status,
      admitted: status === 'admitted',
      reasons,
      revisionHistory: history.map((h) => ({ phase: h.phase, litres: h.litres, page: h.page })),
      revisionVarianceL: maxRevisionDiff,
      withinMeasurementTolerance: maxRevisionDiff <= toleranceL,
    };
    receipts.push(receipt);
  }
  receipts.sort((a, b) => shiftMinutes(a.time) - shiftMinutes(b.time) || String(a.id).localeCompare(String(b.id)));

  // Ownership ledger. Only dual-signed, acyclic and balance-valid transfers move ownership.
  const balances = new Map();
  for (const d of dispatchById.values()) balances.set(d.tank, (balances.get(d.tank) ?? 0) + d.litres);
  const ownershipEdges = [];
  const transferViews = [];
  const eventTimes = [];
  for (const t of allTransferRecords.values()) eventTimes.push({ kind: 'transfer', time: t.time, ref: t.ref, row: t });
  for (const r of receipts) eventTimes.push({ kind: 'receipt', time: r.time, id: r.id, row: r });
  eventTimes.sort((a, b) => shiftMinutes(a.time) - shiftMinutes(b.time) || (a.kind === 'receipt' ? -1 : 1));

  for (const event of eventTimes) {
    if (event.kind === 'receipt') {
      const r = event.row;
      if (!r.admitted) continue;
      balances.set(r.tank, (balances.get(r.tank) ?? 0) - r.litres);
      if ((balances.get(r.tank) ?? 0) < -toleranceL) {
        const route = routeByTank.get(r.tank);
        addIssue({
          code: 'TANK_BALANCE_NEGATIVE',
          village: r.village,
          ticketId: r.id,
          tank: r.tank,
          dispatch: route?.dispatch,
          affectedVillages: [r.village],
          affectedBranches: [{ dispatch: route?.dispatch, tank: r.tank, village: r.village, ticket: r.ticket }],
          balanceL: balances.get(r.tank),
          toleranceL,
        });
      }
      continue;
    }

    const t = event.row;
    const view = { ...t, status: 'pending', ownershipMovedL: 0, issues: [] };
    const sourceBalance = balances.get(t.source_tank) ?? 0;
    if (t.withdrawn) {
      view.status = 'withdrawn';
      view.issues.push('later_revision_removed_record');
    }
    if (!(t.from_signed && t.to_signed)) {
      view.status = 'unconfirmed';
      view.issues.push(!t.from_signed ? 'missing_from_signature' : 'missing_to_signature');
      transferViews.push(view);
      addIssue({
        code: 'TRANSFER_NOT_DUAL_SIGNED',
        transfer: t.ref,
        dispatch: t.dispatch,
        sourceTank: t.source_tank,
        destTank: t.dest_tank,
        litres: t.litres,
        affectedVillages: routeByTank.get(t.dest_tank)?.possible_villages ?? routeByTank.get(t.source_tank)?.possible_villages ?? [],
        affectedBranches: [{ dispatch: t.dispatch, sourceTank: t.source_tank, destTank: t.dest_tank, transfer: t.ref }],
      });
      continue;
    }
    if (createsCycle(ownershipEdges, t.source_tank, t.dest_tank)) {
      view.status = 'rejected_cycle';
      view.issues.push('flow_cycle_prevented');
      transferViews.push(view);
      addIssue({
        code: 'TRANSFER_CYCLE_REJECTED',
        transfer: t.ref,
        dispatch: t.dispatch,
        sourceTank: t.source_tank,
        destTank: t.dest_tank,
        litres: t.litres,
        withdrawn: t.withdrawn,
        affectedVillages: [
          ...new Set([
            ...(routeByTank.get(t.source_tank)?.possible_villages ?? []),
            ...(routeByTank.get(t.dest_tank)?.possible_villages ?? []),
          ]),
        ],
        affectedBranches: [{ dispatch: t.dispatch, sourceTank: t.source_tank, destTank: t.dest_tank, transfer: t.ref }],
      });
      continue;
    }

    const movable = Math.min(t.litres, Math.max(0, sourceBalance));
    const shortage = t.litres - movable;
    balances.set(t.source_tank, sourceBalance - movable);
    balances.set(t.dest_tank, (balances.get(t.dest_tank) ?? 0) + movable);
    ownershipEdges.push([t.source_tank, t.dest_tank]);
    view.ownershipMovedL = movable;
    view.status = shortage > toleranceL ? 'accepted_partial_balance_exception' : 'confirmed';
    if (shortage > 0) {
      view.balanceExceptionL = shortage;
      addIssue({
        code: shortage > toleranceL ? 'TRANSFER_EXCEEDS_AVAILABLE_BALANCE' : 'TRANSFER_BALANCE_TOLERANCE',
        transfer: t.ref,
        dispatch: t.dispatch,
        sourceTank: t.source_tank,
        destTank: t.dest_tank,
        requestedL: t.litres,
        movedL: movable,
        shortageL: shortage,
        toleranceL,
        affectedVillages: routeByTank.get(t.source_tank)?.possible_villages ?? [],
      });
    }
    transferViews.push(view);
  }

  // Reconcile confirmed transfer inflow against destination-tank receipts.
  const suspenseCandidates = [];
  for (const t of transferViews) {
    if (t.status !== 'confirmed' && t.status !== 'accepted_partial_balance_exception') continue;
    const destReceipts = receipts.filter((r) => r.tank === t.dest_tank);
    const admittedL = sum(destReceipts.filter((r) => r.admitted), 'litres');
    const heldL = sum(destReceipts.filter((r) => !r.admitted), 'litres');
    const outgoingL = transferViews
      .filter((x) => x.source_tank === t.dest_tank && (x.status === 'confirmed' || x.status === 'accepted_partial_balance_exception'))
      .reduce((n, x) => n + x.ownershipMovedL, 0);
    const residualL = t.ownershipMovedL - admittedL - outgoingL;
    t.reconciliation = { destAdmittedReceiptsL: admittedL, destHeldReceiptsL: heldL, outgoingConfirmedL: outgoingL, residualL };
    if (residualL > toleranceL) {
      const route = routeByTank.get(t.dest_tank);
      const villagesAffected = route?.possible_villages ?? [];
      addIssue({
        code: 'TRANSFER_RECEIPT_VARIANCE_EXCEEDED',
        transfer: t.ref,
        dispatch: t.dispatch,
        tank: t.dest_tank,
        inflowL: t.ownershipMovedL,
        admittedReceiptsL: admittedL,
        residualL,
        toleranceL,
        tickets: destReceipts.map((r) => r.id),
        affectedVillages: villagesAffected,
        affectedBranches: [{ dispatch: t.dispatch, transfer: t.ref, tank: t.dest_tank, villages: villagesAffected, tickets: destReceipts.map((r) => r.ticket) }],
      });
      for (const village of villagesAffected) {
        suspenseCandidates.push({
          id: `transfer-residual:${t.ref}:${t.dest_tank}`,
          dedupeKey: `tank-balance:${t.dest_tank}`,
          kind: 'unreconciled_transfer_residual',
          village,
          amountL: residualL,
          sourceRefs: [t.ref],
          detail: `X 段转移 ${t.ownershipMovedL}L，已承认小票 ${admittedL}L，余 ${residualL}L 未对上`,
        });
      }
    }
  }

  // Physical source-tank check catches impossible source-signed transfer + receipts.
  const physical = new Map();
  for (const d of dispatchById.values()) physical.set(d.tank, (physical.get(d.tank) ?? 0) + d.litres);
  const physicalEvents = [
    ...asArray(bundle.transfer).map((t) => ({ kind: 'transfer', time: t.time, row: t })),
    ...receipts.map((r) => ({ kind: 'receipt', time: r.time, row: r })),
  ].sort((a, b) => shiftMinutes(a.time) - shiftMinutes(b.time));
  for (const e of physicalEvents) {
    const row = e.row;
    if (e.kind === 'transfer') {
      if (row.from_signed) physical.set(row.source_tank, (physical.get(row.source_tank) ?? 0) - row.litres);
      if (row.to_signed) physical.set(row.dest_tank, (physical.get(row.dest_tank) ?? 0) + row.litres);
    } else {
      // Source-tank meter check uses the village proof even when ownership of a
      // different destination tank is held.
      physical.set(row.tank, (physical.get(row.tank) ?? 0) - row.litres);
    }
  }
  for (const [tank, value] of physical) {
    if (value < -toleranceL) {
      const route = routeByTank.get(tank);
      // A negative destination tank paired with an unconfirmed inflow is already scoped by X2.
      const pairedUnconfirmed = unconfirmedIncoming.has(tank);
      if (pairedUnconfirmed) continue;
      addIssue({
        code: 'PHYSICAL_TANK_VARIANCE_EXCEEDED',
        tank,
        dispatch: route?.dispatch,
        balanceL: value,
        varianceL: Math.abs(value),
        toleranceL,
        affectedVillages: route?.possible_villages ?? [],
        affectedBranches: [{ dispatch: route?.dispatch, tank, villages: route?.possible_villages ?? [] }],
      });
    }
  }

  const orderViews = buildOrderViews(shiftState, bundle);

  const villageReports = villages.map((village) => {
    const targetL = targetByVillage.get(village) ?? 0;
    const villageReceipts = receipts.filter((r) => r.village === village);
    const admittedReceipts = villageReceipts.filter((r) => r.admitted);
    const heldReceipts = villageReceipts.filter((r) => !r.admitted);
    const confirmedReceivedL = sum(admittedReceipts, 'litres');
    const gapL = Math.max(0, targetL - confirmedReceivedL);
    const missing = missingPages.filter((p) => p.village === village);

    const proofCandidates = [
      ...heldReceipts.map((r) => ({
        id: `held-ticket:${r.id}`,
        dedupeKey: `ticket:${r.id}`,
        kind: 'held_ticket',
        village,
        amountL: r.litres,
        sourceRefs: [r.id],
        detail: r.reasons.join('; '),
      })),
      ...suspenseCandidates.filter((c) => c.village === village),
    ];
    const pendingKnownL = proofCandidates.reduce((n, c) => n + c.amountL, 0);
    const pendingCoverageL = missing.length ? gapL : Math.min(gapL, pendingKnownL);
    const knownShortageL = Math.max(0, gapL - pendingCoverageL);

    const villageOrders = orderViews.filter((o) => o.allocations.some((a) => a.village === village));
    const allocationL = (statuses) => villageOrders.reduce((total, o) => {
      if (!statuses.includes(o.status)) return total;
      return total + o.allocations.filter((a) => a.village === village).reduce((n, a) => n + a.litres, 0);
    }, 0);
    const departedL = allocationL(['departed']);
    const acceptedL = allocationL(['accepted', 'confirmed']);
    const activeOrderL = departedL + acceptedL;
    const otherStatusL = villageOrders.reduce((n, o) => {
      if (['departed', 'accepted', 'confirmed'].includes(o.status)) return n;
      return n + o.allocations.filter((a) => a.village === village).reduce((x, a) => x + a.litres, 0);
    }, 0);

    const departedExcessL = Math.max(0, departedL - gapL);
    const gapAfterDepartedL = Math.max(0, gapL - departedL);
    const reassignableAcceptedL = Math.max(0, acceptedL - gapAfterDepartedL);
    const newOrderNeedL = Math.max(0, knownShortageL - activeOrderL);
    const alerts = [];
    if (departedExcessL > 0) {
      alerts.push({
        code: 'DEPARTED_ORDER_EXCESS_TO_DUTY_OFFICER',
        village,
        excessL: departedExcessL,
        orders: villageOrders.filter((o) => o.status === 'departed').map((o) => o.order),
        instruction: '已出车，不能改派；请值班员处理超额交付',
      });
    }
    if (reassignableAcceptedL > 0) {
      alerts.push({
        code: 'ACCEPTED_ORDER_EXCESS_CAN_REASSIGN',
        village,
        reassignableL: reassignableAcceptedL,
        orders: villageOrders.filter((o) => ['accepted', 'confirmed'].includes(o.status)).map((o) => o.order),
        instruction: '已受理未出车，可按请求标识改派',
      });
    }

    const routeRemainders = [...balances.entries()]
      .filter(([tank]) => (routeByTank.get(tank)?.possible_villages ?? []).includes(village))
      .map(([tank, litres]) => ({ tank, litres, dedupeKey: `tank-balance:${tank}`, dispatch: routeByTank.get(tank)?.dispatch }));
    const networkRemainderL = routeRemainders.reduce((n, x) => n + Math.max(0, x.litres), 0);
    const pendingDedupeKeys = new Set(proofCandidates.map((p) => p.dedupeKey));
    const notAlreadyPendingNetworkL = routeRemainders
      .filter((r) => !pendingDedupeKeys.has(r.dedupeKey))
      .reduce((n, r) => n + Math.max(0, r.litres), 0);
    const unencumberedNetworkL = Math.max(0, notAlreadyPendingNetworkL - sum(heldReceipts, 'litres'));
    const networkCoverageL = Math.min(knownShortageL, unencumberedNetworkL);
    const shortageAfterPossibleNetworkL = Math.max(0, knownShortageL - networkCoverageL);
    const unconfirmedTransferL = transferViews
      .filter((t) => t.status === 'unconfirmed')
      .filter((t) => [t.source_tank, t.dest_tank]
        .some((tank) => (routeByTank.get(tank)?.possible_villages ?? []).includes(village)))
      .reduce((n, t) => n + t.litres, 0);

    return {
      village,
      shift: shiftId,
      targetL,
      confirmedReceivedL,
      admittedL: confirmedReceivedL,
      heldReceiptsL: sum(heldReceipts, 'litres'),
      gapL,
      pendingKnownL,
      pendingCoverageL,
      pendingL: pendingCoverageL,
      knownShortageL,
      shortageL: knownShortageL,
      firmSupplementL: newOrderNeedL,
      newOrderNeedL,
      missingPages: missing.map((p) => p.page),
      pendingItems: proofCandidates,
      routeRemainders,
      networkRemainderL,
      unconfirmedTransferL,
      networkCoverageL,
      shortageAfterPossibleNetworkL,
      orders: villageOrders.map((o) => ({
        order: o.order,
        status: o.status,
        origin: o.origin,
        requestKey: o.requestKey,
        sourceRef: o.sourceRef,
        allocations: o.allocations,
        requestedL: o.requestedL,
        acceptedL: o.acceptedL,
      })),
      orderCoverageL: activeOrderL,
      departedL,
      acceptedOrderL: acceptedL,
      otherStatusL,
      departedExcessL,
      reassignableAcceptedL,
      alerts,
      receipts: villageReceipts,
    };
  });

  const dispatchBalances = [...dispatchById.values()].map((d) => {
    const routeTanks = [...routeByTank.values()].filter((r) => r.dispatch === d.dispatch).map((r) => r.tank);
    const admitted = receipts.filter((r) => r.admitted && r.dispatch === d.dispatch);
    const held = receipts.filter((r) => !r.admitted && r.dispatch === d.dispatch);
    const tankBalanceL = routeTanks.reduce((n, tank) => n + (balances.get(tank) ?? 0), 0);
    const remainingL = d.litres - sum(admitted, 'litres');
    return {
      dispatch: d.dispatch,
      tank: d.tank,
      releaseL: d.litres,
      admittedReceiptsL: sum(admitted, 'litres'),
      heldReceiptsL: sum(held, 'litres'),
      ownershipRemainingL: remainingL,
      routeTanks,
      tankBalanceL,
      noDoubleCount: remainingL === tankBalanceL,
    };
  });

  const pageHealth = Object.entries(shiftState.resources ?? {}).map(([resource, entry]) => {
    const checks = entry.checks.filter((c) => c.phase === asOf);
    const versions = entry.versions.map((v) => v.phase);
    return { resource, checks, dataAsOf: bundle[resource] !== undefined, versions };
  });

  // A tank/transfer remainder can be possible for several villages. Keep the
  // resource in one dedupe group so totals never count it as received twice.
  const pendingDedupe = new Map();
  for (const v of villageReports) {
    for (const p of v.pendingItems ?? []) {
      const group = pendingDedupe.get(p.dedupeKey) ?? {
        dedupeKey: p.dedupeKey,
        kind: p.kind,
        amountL: p.amountL,
        villages: new Set(),
        sourceRefs: new Set(),
      };
      group.villages.add(v.village);
      for (const ref of p.sourceRefs ?? []) group.sourceRefs.add(ref);
      pendingDedupe.set(p.dedupeKey, group);
    }
  }
  const sharedPendingGroups = [...pendingDedupe.values()].map((g) => {
    const villages = [...g.villages];
    const gapSumL = villages.reduce((n, id) => n + (villageReports.find((v) => v.village === id)?.gapL ?? 0), 0);
    const perVillagePossibleL = villages.reduce((n, id) => {
      const gap = villageReports.find((v) => v.village === id)?.gapL ?? 0;
      return n + Math.min(g.amountL, gap);
    }, 0);
    const uniqueCoverageL = Math.min(g.amountL, gapSumL);
    return {
      dedupeKey: g.dedupeKey,
      kind: g.kind,
      amountL: g.amountL,
      villages,
      sourceRefs: [...g.sourceRefs],
      sharedAcrossVillages: villages.length > 1,
      uniqueCoverageL,
      possiblePerVillageSumL: perVillagePossibleL,
      doubleCountExposureL: Math.max(0, perVillagePossibleL - uniqueCoverageL),
    };
  });
  const uniqueConcretePendingL = sharedPendingGroups.reduce((n, g) => n + g.uniqueCoverageL, 0);

  return {
    tool: 'water-delivery',
    shift: shiftId,
    asOf,
    toleranceL,
    generatedAt: new Date().toISOString(),
    villages: villageReports,
    transfers: transferViews,
    dispatches: dispatchBalances,
    orders: orderViews,
    issues,
    pageHealth,
    sharedPendingGroups,
    totals: {
      targetL: villageReports.reduce((n, v) => n + v.targetL, 0),
      confirmedReceivedL: villageReports.reduce((n, v) => n + v.confirmedReceivedL, 0),
      pendingCoverageL: villageReports.reduce((n, v) => n + v.pendingCoverageL, 0),
      uniqueConcretePendingL,
      knownShortageL: villageReports.reduce((n, v) => n + v.knownShortageL, 0),
      newOrderNeedL: villageReports.reduce((n, v) => n + v.newOrderNeedL, 0),
      releaseL: dispatchBalances.reduce((n, d) => n + d.releaseL, 0),
      ownershipRemainingL: dispatchBalances.reduce((n, d) => n + d.ownershipRemainingL, 0),
    },
    trace: {
      portalRequests: shiftState.portalRequests ?? {},
      orderEvents: shiftState.orderEvents ?? [],
    },
  };
}
