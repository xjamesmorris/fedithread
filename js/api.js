import { statusApiUrl, contextApiUrl } from './parse.js';

export class ApiError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

const TIMEOUT_MS = 15000;

function describeFailure(status, host) {
  switch (status) {
    case 401:
    case 403:
      return `${host} does not allow anonymous API access. Try the same post as seen from another instance.`;
    case 404:
      return `Post not found on ${host}. It may be private, deleted, or the URL may not be a Mastodon-compatible post link.`;
    case 410:
      return `That post has been deleted on ${host}.`;
    case 422:
      return `${host} rejected the post id. The URL may not point to a status.`;
    case 429:
      return `${host} is rate-limiting requests. Wait a moment and try again.`;
    default:
      return `${host} returned HTTP ${status}.`;
  }
}

export async function getJson(url, { signal } = {}) {
  const host = new URL(url).host;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      if (ctrl.signal.aborted && signal?.aborted) throw err;
      const msg = ctrl.signal.aborted
        ? `Timed out talking to ${host}.`
        : `Could not reach ${host}. It may be offline, block cross-origin requests, or not be a Mastodon-compatible server.`;
      throw new ApiError(msg, { url, cause: err });
    }
    if (!res.ok) throw new ApiError(describeFailure(res.status, host), { status: res.status, url });
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
      throw new ApiError(`${host} did not return JSON. It may not be a Mastodon-compatible server.`, { status: res.status, url });
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function fetchStatus(host, id, opts) {
  return getJson(statusApiUrl(host, id), opts);
}

export function fetchContext(host, id, opts) {
  return getJson(contextApiUrl(host, id), opts);
}

// Minimal concurrency limiter: returns a function that wraps async tasks.
export function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export function fetchAccountStatuses(host, accountId, params = {}, opts) {
  const u = new URL(`${statusApiUrl(host, '0').replace(/\/statuses\/0$/, '')}/accounts/${encodeURIComponent(accountId)}/statuses`);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  return getJson(u.toString(), opts);
}
