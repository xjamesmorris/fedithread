// Build the link the Share button copies: this page, with ?url= pointing at
// the post the reader pasted. The value is assembled from the parsed host and
// host-local id plus the author's public handle, never from the raw pasted
// text (which may carry a tracking query, a /deck/ path or credentials) and
// never from status.url (which for a remote post names a different host and a
// different id). So the link holds only: the app's address, the instance the
// thread was read through, the author's handle, and the post id.

import { parseStatusUrl, scheme, seriesRef } from './parse.js';

// Percent-encode a query value but keep : / @ readable, so the link looks
// like a link. URLSearchParams decodes both forms identically.
const prettyParam = (s) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%40/gi, '@');

// The post reference for the ?url= value, or null. Prefers the Mastodon web
// form https://host/@acct/id; falls back to the bare "host/id" form when the
// handle is unusable. Whatever is returned is checked against our own parser,
// so a link fedithread emits is always a link fedithread can read.
export function statusRef({ host, id, acct }) {
  const candidates = [];
  if (acct && !/[\s/?#]/.test(acct)) candidates.push(`${scheme(host)}://${host}/@${acct}/${id}`);
  candidates.push(`${host}/${id}`);
  for (const c of candidates) {
    const back = parseStatusUrl(c);
    if (back && back.host === host && back.id === id) return c;
  }
  return null;
}

export function shareUrl(pageUrl, target) {
  const ref = statusRef(target);
  if (!ref) return null;
  const page = new URL(pageUrl);
  return `${page.origin}${page.pathname}?url=${prettyParam(ref)}`;
}

export function seriesShareUrl(pageUrl, target, { post = '', view = '' } = {}) {
  if ((post && view) || (view && view !== 'all')) return null;
  const ref = seriesRef(target);
  if (!ref) return null;
  const page = new URL(pageUrl);
  return `${page.origin}${page.pathname}?url=${prettyParam(ref)}${post ? `&post=${encodeURIComponent(post)}` : ''}${view === 'all' ? '&view=all' : ''}`;
}

export function seriesRoute(pageUrl) {
  const params = new URL(pageUrl).searchParams;
  const post = params.get('post') || '';
  const view = params.get('view') || '';
  if ((post && view) || (view && view !== 'all') || params.getAll('post').length > 1 || params.getAll('view').length > 1) {
    return { post: '', view: '', warning: 'That collection view is invalid. Showing the index instead.' };
  }
  return { post, view, warning: '' };
}
