import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectSeries, createSeries, seriesSnapshot, groupArticles } from '../js/series.js';
import { fetchAccount, ApiError } from '../js/api.js';

const target = { host: 'example.test', acct: 'author', tag: 'Works' };
const author = { id: 'author-local-id', acct: 'author', username: 'author', display_name: 'Author', url: 'https://example.test/@author' };
const other = { id: 'other-id', acct: 'other', username: 'other' };
const st = (id, time, parent = null, extra = {}) => ({
  id, created_at: new Date(Date.UTC(2024, 0, 1, 0, time)).toISOString(),
  account: author, in_reply_to_id: parent, in_reply_to_account_id: parent ? author.id : null,
  content: `<p>Article ${id}</p>`, tags: [], visibility: 'public', reblog: null,
  replies_count: 0, url: `https://example.test/@author/${id}`, ...extra,
});
const tagged = { tags: [{ name: 'works' }] };
const fixture = () => [
  st('100000000000000001', 1, null, { ...tagged, replies_count: 2 }),
  st('100000000000000002', 2, '100000000000000001', { replies_count: 1 }),
  st('100000000000000003', 3, '100000000000000001', { account: other, replies_count: 1 }),
  st('100000000000000004', 4, '100000000000000003', { in_reply_to_account_id: other.id }),
  st('100000000000000005', 5, '100000000000000002'),
  st('100000000000000006', 6, null, tagged),
  st('100000000000000007', 7, '100000000000000006'),
  st('100000000000000008', 8),
];

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function server(posts, { pageSize = 2, ignoreCursor = false, ignoreTag = false } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      assert.equal(opts.credentials, 'omit');
      assert.equal(opts.referrerPolicy, 'no-referrer');
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      if (u.pathname.endsWith('/lookup')) return json(author);
      if (u.pathname.includes('/accounts/')) {
        let list = posts.filter((s) => s.account.id === author.id && !s.reblog).sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (u.searchParams.has('tagged') && !ignoreTag) list = list.filter((s) => s.tags.some((t) => t.name.toLowerCase() === 'works'));
        const cursor = u.searchParams.get('max_id');
        const offset = cursor && !ignoreCursor ? list.findIndex((s) => s.id === cursor) + 1 : 0;
        return json(list.slice(offset, offset + pageSize));
      }
      const id = u.pathname.split('/')[4];
      if (u.pathname.endsWith('/context')) {
        const ids = new Set([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const s of posts) if (ids.has(s.in_reply_to_id) && !ids.has(s.id)) { ids.add(s.id); changed = true; }
        }
        return json({ ancestors: [], descendants: posts.filter((s) => ids.has(s.id) && s.id !== id) });
      }
      const post = posts.find((s) => s.id === id);
      return json(post || {}, post ? 200 : 404);
    },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('collects tagged articles once with untagged narrative, not conversational replies', async () => {
  const fake = server(fixture());
  globalThis.fetch = fake.fetch;
  const state = createSeries(target);
  await collectSeries(state);
  const result = seriesSnapshot(state);
  assert.equal(result.complete, true);
  assert.deepEqual(result.articles.map((a) => [...a.main]), [
    ['100000000000000001', '100000000000000002', '100000000000000005'],
    ['100000000000000006', '100000000000000007'],
  ]);
  assert.ok(!fake.calls.some((s) => s.endsWith('/context')));
  assert.equal(new Set(fake.calls).size, fake.calls.length);
  assert.ok(fake.calls.some((s) => s.includes('max_id=100000000000000001')), 'short tag page is followed to exhaustion');
});

test('deduplicates tagged continuations and keeps a tagged author branch and its continuation', () => {
  const posts = [
    st('root', 0),
    st('first', 1, 'root'),
    st('branch', 2, 'root', tagged),
    st('continued', 3, 'branch'),
  ];
  const result = groupArticles(posts, new Set(['branch', 'continued']), author.id, target.host);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'root');
  assert.deepEqual([...result[0].main].sort(), ['branch', 'continued', 'first', 'root']);
});

test('a tagged reply to another author is an author-owned entry, not their conversation', async () => {
  const posts = [st('outside', 0, null, { account: other }), st('own', 1, 'outside', { ...tagged, in_reply_to_account_id: other.id }), st('next', 2, 'own')];
  globalThis.fetch = server(posts).fetch;
  const state = createSeries(target);
  await collectSeries(state);
  const article = seriesSnapshot(state).articles[0];
  assert.equal(article.id, 'own');
  assert.deepEqual([...article.main], ['own', 'next']);
  assert.ok(article.notes.length);
  assert.ok(!article.tree.byId.has('outside'));
});

test('request budgets pause and Continue resumes exact cursors without repeating pages', async () => {
  const posts = Array.from({ length: 100 }, (_, i) => st(`id-${i}`, i, null, tagged));
  const fake = server(posts, { pageSize: 1 });
  globalThis.fetch = fake.fetch;
  const state = createSeries(target);
  await collectSeries(state);
  assert.equal(fake.calls.length, 80);
  assert.match(state.paused, /budget/);
  assert.equal(seriesSnapshot(state).complete, false);
  for (let i = 0; i < 3 && state.stage !== 'ready'; i++) {
    const before = fake.calls.length;
    await collectSeries(state);
    assert.ok(fake.calls.length - before <= 80);
  }
  assert.equal(state.stage, 'ready');
  assert.equal(seriesSnapshot(state).articles.length, 100);
  assert.equal(new Set(fake.calls).size, fake.calls.length);
});

test('optional discussion uses the shared budget, keeps narrative separate and caches completed work', async () => {
  const fake = server(fixture());
  globalThis.fetch = fake.fetch;
  const state = createSeries(target);
  await collectSeries(state);
  const root = '100000000000000001';
  await collectSeries(state, { discussionRoots: [root], maxRequests: 1 });
  const article = seriesSnapshot(state, { includeDiscussion: true }).articles[0];
  assert.equal(article.discussionComplete, true);
  assert.equal(article.tree.byId.size, 5);
  assert.equal(article.main.size, 3);
  const before = fake.calls.length;
  await collectSeries(state, { discussionRoots: [root] });
  assert.equal(fake.calls.length, before);
});

test('empty tags are honestly empty, while ignored filters and repeating pages fail visibly', async () => {
  globalThis.fetch = server([]).fetch;
  const empty = createSeries(target);
  await collectSeries(empty);
  assert.equal(seriesSnapshot(empty).complete, true);
  assert.equal(seriesSnapshot(empty).articles.length, 0);
  globalThis.fetch = server(fixture(), { ignoreTag: true }).fetch;
  await assert.rejects(collectSeries(createSeries(target)), /author\/tag filter/);
  globalThis.fetch = server(fixture(), { ignoreCursor: true }).fetch;
  const stuck = createSeries(target);
  await assert.rejects(collectSeries(stuck), /did not advance/);
  assert.equal(seriesSnapshot(stuck).complete, false);
});

test('a missing author parent is reported in the partial collection', async () => {
  globalThis.fetch = server([st('child', 1, 'deleted', tagged)]).fetch;
  const state = createSeries(target);
  await collectSeries(state);
  const result = seriesSnapshot(state);
  assert.equal(result.articles[0].id, 'child');
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /Earlier post deleted is unavailable/);
});

test('rate limits retain a resumable state without an automatic request loop', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}, 429, { 'retry-after': '60' }); };
  const state = createSeries(target);
  await assert.rejects(collectSeries(state), (e) => e instanceof ApiError && e.retryAt > Date.now());
  await collectSeries(state);
  assert.equal(calls, 1);
  assert.match(state.paused, /Rate limited/);
});

test('account errors describe the resource and cancellation does not become a successful collection', async () => {
  globalThis.fetch = async () => json({}, 404);
  await assert.rejects(fetchAccount(target.host, target.acct), /Account not found/);
  const ctrl = new AbortController();
  ctrl.abort();
  const state = createSeries(target);
  await assert.rejects(collectSeries(state, { signal: ctrl.signal }), { name: 'AbortError' });
  assert.equal(state.totalRequests, 0);
  assert.equal(seriesSnapshot(state).complete, false);
});

test('malformed cyclic author threads fail instead of hanging', async () => {
  globalThis.fetch = server([st('a', 0, 'b', tagged), st('b', 1, 'a')]).fetch;
  await assert.rejects(collectSeries(createSeries(target)), /cyclic/);
});
