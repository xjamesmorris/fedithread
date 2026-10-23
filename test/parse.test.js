import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusUrl, parseSeriesUrl, parseInput, seriesRef } from '../js/parse.js';

const cases = [
  ['https://mastodon.social/@Gargron/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['https://fosstodon.org/@someone@other.example/112233445566', { host: 'fosstodon.org', id: '112233445566' }],
  ['https://mastodon.social/deck/@Gargron/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['https://mastodon.social/users/Gargron/statuses/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['https://gts.example/@me/statuses/01H8ZJ0X5Q8YQ7R2', { host: 'gts.example', id: '01H8ZJ0X5Q8YQ7R2' }],
  ['https://akkoma.example/notice/AbCdEf123456', { host: 'akkoma.example', id: 'AbCdEf123456' }],
  ['https://pixelfed.social/p/user/654321987', { host: 'pixelfed.social', id: '654321987' }],
  ['https://mastodon.social/web/statuses/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['https://mastodon.social/@Gargron/110000000000000000/', { host: 'mastodon.social', id: '110000000000000000' }],
  ['  https://mastodon.social/@Gargron/110000000000000000?x=1#frag  ', { host: 'mastodon.social', id: '110000000000000000' }],
  ['mastodon.social/@Gargron/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['mastodon.social 110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['mastodon.social/110000000000000000', { host: 'mastodon.social', id: '110000000000000000' }],
  ['http://localhost:3000/@me/12345', { host: 'localhost:3000', id: '12345' }],
  ['https://weird.example/some/deep/path/ABCDEFGH', { host: 'weird.example', id: 'ABCDEFGH' }],
];

for (const [input, expected] of cases) {
  test(`parses ${input.trim()}`, () => {
    assert.deepEqual(parseStatusUrl(input), expected);
  });
}

const junk = ['', '   ', 'hello', 'https://mastodon.social/', 'https://mastodon.social/@Gargron', 'ftp://x.example/@a/123', 'not a url at all', null, undefined];
for (const input of junk) {
  test(`rejects ${JSON.stringify(input)}`, () => {
    assert.equal(parseStatusUrl(input), null);
  });
}

test('dispatches tagged author URLs before the status-id fallback', () => {
  const text = 'https://mastodon.social/@pid_eins/tagged/systemd262/?utm_source=x#old';
  const target = { host: 'mastodon.social', acct: 'pid_eins', tag: 'systemd262' };
  assert.deepEqual(parseSeriesUrl(text), target);
  assert.deepEqual(parseInput(text), { kind: 'series', ...target });
  assert.equal(parseStatusUrl(text), null);
  assert.equal(seriesRef(target), 'https://mastodon.social/@pid_eins/tagged/systemd262');
  assert.deepEqual(parseInput('host.example/@a/123'), { kind: 'thread', host: 'host.example', id: '123' });
});

test('series references round-trip remote accounts and Unicode tags', () => {
  const target = { host: 'localhost:3000', acct: 'a@remote.example', tag: '日本語_café' };
  assert.deepEqual(parseSeriesUrl(seriesRef(target)), target);
  assert.deepEqual(parseSeriesUrl('host.example/@a/tagged/cafe%CC%81'), { host: 'host.example', acct: 'a', tag: 'café' });
});

test('malformed collection links cannot become status requests', () => {
  for (const text of [
    'https://host.example/@a/tagged',
    'https://host.example/@a/tagged/',
    'https://host.example/@a/tagged/foo/barbar',
    'https://host.example/@a/tagged/bad%2Ftag',
    'https://host.example/@a/tagged/bad%20tag',
    'https://host.example/@a/tagged/%FF',
    'https://user:secret@host.example/@a/tagged/topic',
    'ftp://host.example/@a/tagged/topic',
  ]) assert.equal(parseInput(text), null, text);
});
