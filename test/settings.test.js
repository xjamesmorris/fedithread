import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, replyUrl } from '../js/settings.js';

const hosts = [
  ['mastodon.social', 'mastodon.social'],
  ['  Mastodon.Social/ ', 'mastodon.social'],
  ['https://fosstodon.org/', 'fosstodon.org'],
  ['https://fosstodon.org/@me', 'fosstodon.org'],
  ['@me@hachyderm.io', 'hachyderm.io'],
  ['me@hachyderm.io', 'hachyderm.io'],
  ['localhost:3000', 'localhost:3000'],
  ['', ''],
  ['not a host', ''],
  ['nodots', ''],
];
for (const [input, expected] of hosts) {
  test(`normalizeHost(${JSON.stringify(input)})`, () => assert.equal(normalizeHost(input), expected));
}

test('replyUrl builds the remote-interaction link', () => {
  const status = { uri: 'https://legal.social/users/malteengeler/statuses/117069642548297046' };
  assert.equal(
    replyUrl('https://mastodon.social/', status),
    'https://mastodon.social/authorize_interaction?uri=https%3A%2F%2Flegal.social%2Fusers%2Fmalteengeler%2Fstatuses%2F117069642548297046',
  );
});

test('replyUrl falls back to url and returns null without a home', () => {
  assert.match(replyUrl('x.example', { url: 'https://a.example/@b/1' }), /^https:\/\/x\.example\/authorize_interaction\?uri=https%3A%2F%2Fa\.example/);
  assert.equal(replyUrl('', { uri: 'https://a.example/1' }), null);
  assert.equal(replyUrl('x.example', {}), null);
});
