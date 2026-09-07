import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareUrl, statusRef } from '../js/share.js';
import { parseStatusUrl } from '../js/parse.js';

// The page's own query and hash must be dropped, the path kept.
const PAGE = 'https://xjamesmorris.github.io/fedithread/?url=https%3A%2F%2Fold.example%2F%40x%2F1#s-1';
const BASE = 'https://xjamesmorris.github.io/fedithread/';

const cases = [
  [{ host: 'mastodon.social', id: '115937278949559805', acct: 'Gargron' }, 'https://mastodon.social/@Gargron/115937278949559805'],
  // A remote post read through mastodon.social: keep that host and its local id, not status.url.
  [{ host: 'mastodon.social', id: '117069642737661732', acct: 'malteengeler@legal.social' }, 'https://mastodon.social/@malteengeler@legal.social/117069642737661732'],
  [{ host: 'gts.example', id: '01H8ZJ0X5Q8YQ7R2', acct: 'me' }, 'https://gts.example/@me/01H8ZJ0X5Q8YQ7R2'],
  [{ host: 'akkoma.example', id: 'AbCdEf123456', acct: 'user' }, 'https://akkoma.example/@user/AbCdEf123456'],
  [{ host: 'mastodon.example:8443', id: '1234', acct: 'a' }, 'https://mastodon.example:8443/@a/1234'],
  [{ host: 'localhost:3000', id: '12345', acct: 'me' }, 'http://localhost:3000/@me/12345'],
  [{ host: 'xn--mnchen-3ya.example', id: '42', acct: 'a' }, 'https://xn--mnchen-3ya.example/@a/42'],
  [{ host: 'pixelfed.social', id: '654321987', acct: 'user' }, 'https://pixelfed.social/@user/654321987'],
  // No usable handle: fall back to the bare form the parser also accepts.
  [{ host: 'mastodon.social', id: '115937278949559805', acct: '' }, 'mastodon.social/115937278949559805'],
  [{ host: 'mastodon.social', id: '115937278949559805', acct: undefined }, 'mastodon.social/115937278949559805'],
  [{ host: 'mastodon.social', id: '115937278949559805', acct: 'odd/handle' }, 'mastodon.social/115937278949559805'],
];

for (const [target, ref] of cases) {
  test(`share link for ${JSON.stringify(target)}`, () => {
    const link = shareUrl(PAGE, target);
    assert.equal(link, `${BASE}?url=${ref}`);
    // Round trip: the browser decodes the value back to exactly the reference...
    const back = new URL(link).searchParams.get('url');
    assert.equal(back, ref);
    // ...and our parser reads it as the same host and id that produced it.
    assert.deepEqual(parseStatusUrl(back), { host: target.host, id: target.id });
  });
}

test('share link keeps a file name in the page path and reads naturally', () => {
  const link = shareUrl('http://localhost:8000/index.html', { host: 'mastodon.social', id: '1234', acct: 'a' });
  assert.equal(link, 'http://localhost:8000/index.html?url=https://mastodon.social/@a/1234');
  assert.doesNotMatch(link, /%/);
});

test('share link is null when no form the parser accepts exists', () => {
  // A short non-numeric id parses from a /notice/ path but from no form we can emit.
  assert.equal(statusRef({ host: 'akkoma.example', id: 'abc', acct: 'a' }), null);
  assert.equal(shareUrl(BASE, { host: 'akkoma.example', id: 'abc', acct: 'a' }), null);
});

test('share link never carries the page query, hash or the reader settings', () => {
  const link = shareUrl(`${BASE}?url=x&home=hachyderm.io#s-9`, { host: 'mastodon.social', id: '1234', acct: 'a' });
  const u = new URL(link);
  assert.equal(u.hash, '');
  assert.deepEqual([...u.searchParams.keys()], ['url']);
});
