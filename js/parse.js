// Turn whatever the user pasted into { host, id } for the Mastodon-compatible API.
//
// Anonymous search cannot resolve remote URLs, so we always talk to the host
// that appears in the URL. The id in a URL like https://host/@user@other/123
// is host-local, which is exactly what host's API wants.

const ID_RE = /^(\d+|[A-Za-z0-9_-]{6,})$/;

// Path patterns, most specific first. Each captures the id as group 1.
const PATH_PATTERNS = [
  /^\/(?:deck\/)?@[^/]+\/(\d+)\/?$/,              // Mastodon: /@user/123, /@user@remote/123, /deck/@user/123
  /^\/@[^/]+\/statuses\/([A-Za-z0-9_-]+)\/?$/,    // GoToSocial: /@user/statuses/ID
  /^\/users\/[^/]+\/statuses\/([A-Za-z0-9_-]+)\/?$/, // ActivityPub URI form
  /^\/notice\/([A-Za-z0-9_-]+)\/?$/,              // Pleroma / Akkoma
  /^\/objects\/([A-Za-z0-9_-]+)\/?$/,             // Pleroma object URI
  /^\/p\/[^/]+\/(\d+)\/?$/,                       // Pixelfed
  /^\/i\/web\/statuses\/(\d+)\/?$/,               // Fedilab / Elk style
  /^\/web\/(?:@[^/]+\/|statuses\/)(\d+)\/?$/,     // Old Mastodon advanced web UI
];

function cleanHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/].*$/, '');
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(h)) return null;
  if (!h.includes('.') && !h.startsWith('localhost')) return null;
  return h;
}

export function parseStatusUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  // Bare "host id" or "host/id" or "host id" forms.
  const bare = text.match(/^((?:[a-z0-9.-]+\.[a-z0-9-]+|localhost)(?::\d+)?)[\s/]+([A-Za-z0-9_-]+)$/i);
  if (bare && ID_RE.test(bare[2])) {
    const host = cleanHost(bare[1]);
    if (host) return { host, id: bare[2] };
  }

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = cleanHost(url.host);
  if (!host) return null;

  const path = url.pathname;
  for (const re of PATH_PATTERNS) {
    const m = path.match(re);
    if (m) return { host, id: m[1] };
  }

  // Fallback: last path segment that looks like an id.
  const segs = path.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last && ID_RE.test(last) && segs.length >= 2) return { host, id: last };

  return null;
}

const scheme = (host) => (host.startsWith('localhost') ? 'http' : 'https');

export function statusApiUrl(host, id) {
  return `${scheme(host)}://${host}/api/v1/statuses/${encodeURIComponent(id)}`;
}

export function contextApiUrl(host, id) {
  return `${statusApiUrl(host, id)}/context`;
}
