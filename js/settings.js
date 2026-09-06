// Home instance setting, kept in localStorage. Used to hand "reply" off to the
// user's own client through Mastodon's remote-interaction page.

const KEY = 'fedithread.home';

export function normalizeHost(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  // "@user@host" or "user@host" -> host
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(s)) return '';
  if (!s.includes('.') && !s.startsWith('localhost')) return '';
  return s;
}

export function replyUrl(home, status) {
  const host = normalizeHost(home);
  const uri = status?.uri || status?.url;
  if (!host || !uri) return null;
  const scheme = host.startsWith('localhost') ? 'http' : 'https';
  return `${scheme}://${host}/authorize_interaction?uri=${encodeURIComponent(uri)}`;
}

function storage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function getHomeInstance() {
  try { return normalizeHost(storage()?.getItem(KEY) || ''); } catch { return ''; }
}

export function setHomeInstance(value) {
  const host = normalizeHost(value);
  try {
    if (host) storage()?.setItem(KEY, host);
    else storage()?.removeItem(KEY);
  } catch { /* private mode or blocked storage: setting just won't persist */ }
  return host;
}
