import { SourceClient } from './source.mjs';
import { getShift } from './store.mjs';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function acceptedLitresFrom(body, facts) {
  const requested = Number(facts?.litres ?? facts?.requestedL ?? 0) || 0;
  const explicit = Number(
    body?.acceptedLitres
      ?? body?.accepted_litres
      ?? body?.acceptedL
      ?? body?.approvedLitres
      ?? body?.approved_litres,
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (Number.isFinite(Number(body?.litres)) && Number(body?.litres) > 0 && body?.result === 'accepted') {
    return Number(body.litres);
  }
  return body?.result === 'accepted' || body?.result === 'confirmed' ? requested : 0;
}

function applyAcceptedEffect(shiftState, record, body) {
  const facts = record.requestPayload?.facts ?? record.payload?.facts ?? {};
  const acceptedL = acceptedLitresFrom(body, facts);
  if (record.effectsApplied) {
    if (record.action === 'reassign') {
      const event = shiftState.orderEvents.find((e) => e.key === record.key);
      if (event) {
        event.acceptedL = acceptedL;
        event.status = body.result ?? event.status;
        event.sourceRef = body.sourceRef ?? event.sourceRef;
        event.orderRef = body.order ?? event.orderRef;
      }
    }
    return false;
  }
  if (record.action === 'reassign' && (body?.result === 'accepted' || body?.result === 'confirmed')) {
    if (!shiftState.orderEvents.some((e) => e.key === record.key)) {
      shiftState.orderEvents.push({
        key: record.key,
        at: new Date().toISOString(),
        phase: record.phase,
        action: 'reassign',
        order: body.order ?? facts.order,
        orderRef: body.order ?? facts.order,
        fromVillage: facts.fromVillage,
        toVillage: facts.toVillage,
        litres: Number(facts.litres ?? 0) || 0,
        acceptedL,
        reason: facts.reason ?? '',
        sourceRef: body.sourceRef,
        status: body.result,
        applied: true,
      });
    }
  }
  record.effectsApplied = true;
  record.status = body.result ?? record.status ?? 'accepted';
  record.orderRef = body.order ?? record.orderRef ?? facts.order;
  record.sourceRef = body.sourceRef ?? record.sourceRef;
  record.acceptedL = acceptedL;
  return true;
}

/** Record an out-of-band or repeated dispatch-desk receipt under an idempotency key. */
export function ingestPortalReceipt(state, shiftId, payload, body, httpStatus = 200, phase = 'confirmed') {
  const shiftState = getShift(state, shiftId);
  return recordResponse(shiftState, payload, phase, httpStatus, body);
}

function recordResponse(shiftState, payload, phase, httpStatus, body) {
  const key = payload.key;
  const now = new Date().toISOString();
  const existing = shiftState.portalRequests[key];
  const samePayload = !existing || canonical(existing.requestPayload) === canonical(payload);
  const record = existing ?? {
    key,
    action: payload.action,
    phase,
    requestPayload: payload,
    requestedL: Number(payload.facts?.litres ?? 0) || 0,
    createdAt: now,
    receipts: [],
    effectsApplied: false,
  };

  record.lastAt = now;
  record.phase = phase;
  record.lastHttpStatus = httpStatus;
  record.receipts.push({ at: now, phase, status: httpStatus, body });

  if (!samePayload) {
    record.conflict = true;
    shiftState.portalRequests[key] = record;
    const error = new Error('请求号已对应其他报文');
    error.code = 'REQUEST_KEY_CONFLICT';
    error.status = 409;
    throw error;
  }

  if (body && typeof body === 'object') {
    record.orderRef = body.order ?? record.orderRef ?? payload.facts?.order;
    record.sourceRef = body.sourceRef ?? record.sourceRef;
    record.result = body.result ?? record.result;
    if (httpStatus === 200 || httpStatus === 201) {
      record.status = body.result ?? 'accepted';
      applyAcceptedEffect(shiftState, record, body);
    } else {
      record.status = httpStatus === 503 ? 'receipt_unknown' : `http_${httpStatus}`;
    }
  } else {
    record.status = `http_${httpStatus}`;
  }

  shiftState.portalRequests[key] = record;
  return record;
}

export async function postPortal(state, shiftId, { action, key, facts, phase = 'confirmed', client } = {}) {
  if (!key || typeof key !== 'string') throw new Error('必须提供唯一 --key');
  if (!['request', 'reassign', 'inspect'].includes(action)) throw new Error('不支持的门户操作: ' + action);
  const shiftState = getShift(state, shiftId);
  const payload = facts === undefined ? { action, key } : { action, key, facts };
  const portal = client ?? new SourceClient({ baseUrl: state.baseUrl });
  const response = await portal.postPortal(phase, payload);
  const record = recordResponse(shiftState, payload, phase, response.status, response.body);
  return { ...response, record };
}

export async function inspectRequest(state, shiftId, key, options = {}) {
  const phase = options.phase ?? 'confirmed';
  const shiftState = getShift(state, shiftId);
  const portal = options.client ?? new SourceClient({ baseUrl: state.baseUrl });
  const response = await portal.postPortal(phase, { action: 'inspect', key });
  if (response.ok && response.body) {
    const existing = shiftState.portalRequests[key];
    if (existing) {
      existing.inspections = existing.inspections ?? [];
      existing.inspections.push({ at: new Date().toISOString(), phase, status: response.status, body: response.body });
      recordResponse(shiftState, existing.requestPayload, phase, response.status, response.body);
    } else {
      shiftState.portalRequests[key] = {
        key,
        action: 'inspect',
        phase,
        status: response.body.result,
        orderRef: response.body.order,
        sourceRef: response.body.sourceRef,
        receipts: [{ at: new Date().toISOString(), phase, status: response.status, body: response.body }],
        effectsApplied: false,
        remoteOnly: true,
      };
    }
  }
  return response;
}

/**
 * Idempotent high-level new water truck request.
 */
export async function requestTruck(state, shiftId, input, options = {}) {
  const key = input.key;
  const facts = {
    village: input.village,
    litres: Number(input.litres),
    reason: input.reason ?? 'known_uncovered_after_pending_evidence',
    ...(input.facts ?? {}),
  };
  return postPortal(state, shiftId, { action: 'request', key, facts, phase: input.phase, ...options });
}

/**
 * Reassign an accepted, not-yet-departed order. Departed orders are refused
 * locally before calling the portal.
 */
export async function reassignOrder(state, report, shiftId, input, options = {}) {
  const orderReport = report.villages
    .flatMap((v) => v.orders)
    .find((o) => o.order === input.order);
  if (orderReport?.status === 'departed') {
    const error = new Error(`派车单 ${input.order} 已出车，不能改派；请将超额提示交值班员`);
    error.code = 'ORDER_DEPARTED';
    throw error;
  }
  const facts = {
    order: input.order,
    fromVillage: input.fromVillage,
    toVillage: input.toVillage,
    litres: Number(input.litres),
    reason: input.reason ?? '',
    ...(input.facts ?? {}),
  };
  return postPortal(state, shiftId, { action: 'reassign', key: input.key, facts, phase: input.phase, ...options });
}
