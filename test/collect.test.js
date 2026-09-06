import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { collectThread, buildTree, classifyNodes } from '../js/thread.js';

// A fake Mastodon server that applies the anonymous caps: context returns at
// most 40 ancestors and a 60-descendant depth-first prefix; account statuses
// page forward with min_id.
function fakeServer(statuses) {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const kids = (id) => statuses.filter((s) => s.in_reply_to_id === id).sort((a, b) => Number(a.id) - Number(b.id));
  const ancestors = (id) => {
    const out = [];
    let s = byId.get(id);
    while (s?.in_reply_to_id) { s = byId.get(s.in_reply_to_id); if (s) out.unshift(s); }
    return out.slice(-40);
  };
  const descendants = (id) => {
    const out = [];
    const walk = (pid) => { for (const k of kids(pid)) { if (out.length >= 60) return; out.push(k); walk(k.id); } };
    walk(id);
    return out;
  };
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    calls,
    fetch: async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + u.search);
      let m;
      if ((m = u.pathname.match(/^\/api\/v1\/statuses\/(\d+)\/context$/))) {
        return byId.has(m[1]) ? json({ ancestors: ancestors(m[1]), descendants: descendants(m[1]) }) : json({ error: 'nope' }, 404);
      }
      if ((m = u.pathname.match(/^\/api\/v1\/statuses\/(\d+)$/))) {
        return byId.has(m[1]) ? json(byId.get(m[1])) : json({ error: 'nope' }, 404);
      }
      if ((m = u.pathname.match(/^\/api\/v1\/accounts\/(\w+)\/statuses$/))) {
        const minId = Number(u.searchParams.get('min_id') || 0);
        const page = statuses.filter((s) => s.account.id === m[1] && Number(s.id) > minId)
          .sort((a, b) => Number(a.id) - Number(b.id)).slice(0, 40).reverse();
        return json(page);
      }
      return json({ error: 'unknown' }, 404);
    },
  };
}

let nextId = 1000;
const mk = (parent, acct, replies = 0) => ({
  id: String(nextId++), in_reply_to_id: parent, account: { id: acct, acct },
  created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, 0, nextId)).toISOString(), replies_count: replies,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { nextId = 1000; });

test('recovers the self-reply chain buried past the descendant cap', async () => {
  const all = [];
  const root = mk(null, 'op'); all.push(root);
  // 80 early replies from others, each with a reply of its own: 160 posts before op continues.
  for (let i = 0; i < 80; i++) {
    const r = mk(root.id, `u${i}`, 1); all.push(r);
    all.push(mk(r.id, 'op-ish', 0));
  }
  root.replies_count = 81;
  // OP's 30-post continuation, each with one side reply.
  let prev = root;
  const chain = [];
  for (let i = 0; i < 30; i++) {
    const p = mk(prev.id, 'op', 2); all.push(p); chain.push(p);
    all.push(mk(p.id, `side${i}`, 0));
    prev = p;
  }
  chain[chain.length - 1].replies_count = 1;
  const server = fakeServer(all);
  globalThis.fetch = server.fetch;

  const r = await collectThread('example.test', root.id, {});
  const ids = new Set(r.statuses.map((s) => s.id));
  for (const p of chain) assert.ok(ids.has(p.id), `chain post ${p.id} present`);
  const tree = buildTree(r.statuses);
  const main = classifyNodes(tree, root.id, root.id);
  assert.equal(main.size, 31);
  assert.ok(r.missing > 0, 'reports replies it could not reach');
  assert.ok(r.requests <= 80);
  assert.equal(r.truncated, false);
});

test('finds the root from a deep start and stops when everything is known', async () => {
  const all = [];
  const root = mk(null, 'op', 1); all.push(root);
  let prev = root;
  for (let i = 0; i < 50; i++) { const p = mk(prev.id, 'op', i < 49 ? 1 : 0); all.push(p); prev = p; }
  const server = fakeServer(all);
  globalThis.fetch = server.fetch;
  const r = await collectThread('example.test', prev.id, {});
  assert.equal(r.root.id, root.id);
  assert.equal(r.statuses.length, 51);
  assert.equal(r.missing, 0);
});

test('surfaces API errors for the starting status', async () => {
  globalThis.fetch = fakeServer([]).fetch;
  await assert.rejects(collectThread('example.test', '1', {}), /not found/i);
});
