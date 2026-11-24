import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_STATE_PATH = resolve(process.cwd(), '.water-state.json');

export function emptyState(baseUrl = 'http://127.0.0.1:4173') {
  return {
    version: 1,
    baseUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shifts: {},
  };
}

export function emptyShift(shift) {
  return {
    shift,
    resources: {},
    portalRequests: {},
    orderEvents: [],
    dutyAlerts: [],
  };
}

export async function loadState(path = DEFAULT_STATE_PATH) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || typeof parsed.shifts !== 'object') {
      throw new Error('状态文件版本不受支持');
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveState(state, path = DEFAULT_STATE_PATH) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = target + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, target);
}

export function getShift(state, shift) {
  if (!state.shifts[shift]) state.shifts[shift] = emptyShift(shift);
  return state.shifts[shift];
}
