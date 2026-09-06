import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatusUrl } from '../js/parse.js';

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
