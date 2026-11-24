import { getShift } from './store.mjs';

export const PHASES = ['opening', 'interim', 'confirmed'];
export const phaseRank = (phase) => {
  const i = PHASES.indexOf(phase);
  if (i < 0) throw new Error('未知发布阶段: ' + phase);
  return i;
};

export class SourceClient {
  constructor({ baseUrl = 'http://127.0.0.1:4173', fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(phase, resource) {
    return `${this.baseUrl}/v1/${phase}/${resource}`;
  }

  async getResource(phase, resource) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url(phase, resource), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return {
        ok: response.ok,
        status: response.status,
        phase: response.headers?.get?.('x-release') ?? phase,
        resource,
        body,
        problem: response.ok ? null : response.status === 404 ? 'not_delivered' : response.status === 503 ? 'unavailable' : 'http_error',
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        phase,
        resource,
        body: null,
        problem: error?.name === 'AbortError' ? 'timeout' : 'network',
        error: error?.message ?? String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async postPortal(phase, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/${phase}/portal`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { ok: response.ok, status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

function unchanged(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recordResult(shiftState, phase, resource, result) {
  const entry = shiftState.resources[resource] ??= { resource, checks: [], versions: [] };
  entry.checks.push({
    phase,
    at: new Date().toISOString(),
    status: result.status,
    ok: result.ok,
    problem: result.problem,
    xRelease: result.phase,
    error: result.error,
  });
  if (result.ok) {
    const last = entry.versions[entry.versions.length - 1];
    if (!last || !unchanged(last.data, result.body)) {
      entry.versions.push({ phase, at: new Date().toISOString(), data: result.body });
    } else if (last) {
      last.lastConfirmedAt = new Date().toISOString();
    }
  }
  return result;
}

async function syncOne(client, shiftState, phase, resource) {
  const result = await client.getResource(phase, resource);
  return recordResult(shiftState, phase, resource, result);
}

/**
 * Collect one or more release phases. A 404/503 is recorded, never thrown and
 * never causes previously collected pages to be deleted.
 */
export async function collectRelease(state, phase, options = {}) {
  const client = options.client ?? new SourceClient({ baseUrl: state.baseUrl, ...options.clientOptions });
  const summary = { phase, fetched: [], failed: [], retainedFromEarlier: [] };

  // Resolve the shift before recording so later shifts do not land in N33.
  const targetsPreliminary = await client.getResource(phase, 'targets');
  let shiftId = options.shift ?? targetsPreliminary.body?.[0]?.shift;
  let plantPreliminary = null;
  if (!shiftId) {
    plantPreliminary = await client.getResource(phase, 'plant-index');
    shiftId = options.shift ?? plantPreliminary.body?.shift ?? 'N33';
  }
  const shiftState = getShift(state, shiftId);
  recordResult(shiftState, phase, 'targets', targetsPreliminary);

  const initial = await Promise.all([
    plantPreliminary
      ? Promise.resolve(recordResult(shiftState, phase, 'plant-index', plantPreliminary))
      : syncOne(client, shiftState, phase, 'plant-index'),
    syncOne(client, shiftState, phase, 'villages'),
    syncOne(client, shiftState, phase, 'transfer'),
    syncOne(client, shiftState, phase, 'orders'),
    syncOne(client, shiftState, phase, 'routes'),
  ]);
  initial.unshift(targetsPreliminary);

  summary.shift = shiftId;

  for (const r of initial) {
    if (r.ok) summary.fetched.push(r.resource);
    else {
      summary.failed.push({ resource: r.resource, status: r.status, problem: r.problem });
      if (shiftState.resources[r.resource]?.versions?.length) summary.retainedFromEarlier.push(r.resource);
    }
  }

  const plantIndex = shiftState.resources['plant-index']?.versions?.at(-1)?.data;
  const plantPages = Array.isArray(plantIndex?.pages) ? plantIndex.pages : [];
  for (const page of plantPages) {
    const r = await syncOne(client, shiftState, phase, page);
    if (r.ok) summary.fetched.push(page);
    else {
      summary.failed.push({ resource: page, status: r.status, problem: r.problem });
      if (shiftState.resources[page]?.versions?.length) summary.retainedFromEarlier.push(page);
    }
  }

  const villagesIndex = shiftState.resources.villages?.versions?.at(-1)?.data;
  const villagePages = Array.isArray(villagesIndex)
    ? [...new Set(villagesIndex.flatMap((v) => Array.isArray(v.pages) ? v.pages : []))]
    : [];
  for (const page of villagePages) {
    const r = await syncOne(client, shiftState, phase, page);
    if (r.ok) summary.fetched.push(page);
    else {
      summary.failed.push({ resource: page, status: r.status, problem: r.problem });
      if (shiftState.resources[page]?.versions?.length) summary.retainedFromEarlier.push(page);
    }
  }

  summary.shift = shiftId;
  return summary;
}

export async function collectPhases(state, phases = PHASES, options = {}) {
  const out = [];
  for (const phase of phases) out.push(await collectRelease(state, phase, options));
  return out;
}
