import { fetchStatus, fetchContext, fetchAccountStatuses, pLimit } from './api.js';

// Anonymous context responses are capped by the server (Mastodon: 40 ancestors,
// 60 descendants as a depth-first prefix, depth 20). Re-requesting the same
// node returns the same prefix, so we recover what we can from other angles:
//   1. context of the start status and of the root
//   2. the root author's own statuses after the root, paged forward, to find
//      the self-reply chain even when it is buried past the descendant cap
//   3. a fill pass: context of every node that reports more replies than we
//      have seen, which pulls in subtrees the prefix cut off
// Replies to a node beyond its 60-descendant prefix stay unreachable
// anonymously; we count and report them.
export const LIMITS = {
  maxRequests: 80,
  maxAncestorHops: 6,
  maxAuthorPages: 8,
  concurrency: 4,
};

export async function collectThread(host, id, { onProgress = () => {}, signal, limits = LIMITS } = {}) {
  const statuses = new Map();
  const expanded = new Set();
  let requests = 0;
  const limit = pLimit(limits.concurrency);

  const add = (s) => {
    if (!s || !s.id) return false;
    if (statuses.has(s.id)) return false;
    statuses.set(s.id, s);
    return true;
  };
  const report = (pending = 0) => onProgress({ posts: statuses.size, requests, pending });

  const context = async (sid) => {
    requests++;
    expanded.add(sid);
    const ctx = await limit(() => fetchContext(host, sid, { signal }));
    for (const s of ctx.ancestors || []) add(s);
    for (const s of ctx.descendants || []) add(s);
    report();
    return ctx;
  };

  requests++;
  const start = await fetchStatus(host, id, { signal });
  add(start);
  report();

  let ctx = await context(start.id);

  // Find the root. If the ancestor list may have been truncated, keep climbing.
  let top = ctx.ancestors?.[0] ?? start;
  for (let hop = 0; hop < limits.maxAncestorHops && top.in_reply_to_id; hop++) {
    const upper = await context(top.id);
    if (!upper.ancestors?.length) break;
    top = upper.ancestors[0];
  }
  const root = top;
  if (!expanded.has(root.id)) await context(root.id);

  // Root author's own posts after the root: recovers the self-reply chain.
  const authorId = root.account?.id;
  if (authorId) {
    let minId = root.id;
    let quietPages = 0;
    for (let page = 0; page < limits.maxAuthorPages && requests < limits.maxRequests; page++) {
      requests++;
      let batch;
      try {
        batch = await fetchAccountStatuses(host, authorId, { min_id: minId, limit: 40, exclude_reblogs: true }, { signal });
      } catch {
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;
      batch.sort((a, b) => (a.id.length - b.id.length) || a.id.localeCompare(b.id));
      let found = 0;
      for (const s of batch) {
        if (s.in_reply_to_id && statuses.has(s.in_reply_to_id)) { add(s); found++; }
      }
      minId = batch[batch.length - 1].id;
      report();
      quietPages = found ? 0 : quietPages + 1;
      if (quietPages >= 3) break;
    }
  }

  // Fill pass: nodes that claim more replies than we know about.
  const childCounts = () => {
    const counts = new Map();
    for (const s of statuses.values()) {
      if (s.in_reply_to_id) counts.set(s.in_reply_to_id, (counts.get(s.in_reply_to_id) || 0) + 1);
    }
    return counts;
  };

  let truncated = false;
  for (;;) {
    const counts = childCounts();
    const todo = [...statuses.values()]
      .filter((s) => !expanded.has(s.id) && (s.replies_count || 0) > (counts.get(s.id) || 0))
      .sort((a, b) => (b.replies_count || 0) - (a.replies_count || 0));
    if (todo.length === 0) break;
    const budget = limits.maxRequests - requests;
    if (budget <= 0) { truncated = true; break; }
    const batch = todo.slice(0, budget);
    report(batch.length);
    await Promise.all(batch.map((s) => context(s.id).catch(() => { /* one failure should not kill the thread */ })));
  }

  // Replies the server told us about but never showed us.
  const counts = childCounts();
  let missing = 0;
  for (const s of statuses.values()) {
    if (expanded.has(s.id)) missing += Math.max(0, (s.replies_count || 0) - (counts.get(s.id) || 0));
  }

  return { root, start, statuses: [...statuses.values()], requests, truncated, missing };
}

// Pure: build parent->children map, sorted by creation time.
export function buildTree(statusList) {
  const byId = new Map();
  for (const s of statusList) byId.set(s.id, s);

  const children = new Map();
  let orphans = 0;
  for (const s of byId.values()) {
    const pid = s.in_reply_to_id;
    if (!pid) continue;
    if (!byId.has(pid)) { orphans++; continue; }
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(s);
  }
  const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id.localeCompare(b.id));
  for (const list of children.values()) list.sort(byTime);

  const roots = [...byId.values()].filter((s) => !s.in_reply_to_id || !byId.has(s.in_reply_to_id));
  roots.sort(byTime);
  return { byId, children, roots, orphans };
}

// Pure: which ids are on the main line. The main line is the root author's
// self-reply chain (earliest self-reply at each step) plus the path from the
// starting status up to the root.
export function classifyNodes(tree, rootId, startId) {
  const main = new Set();
  const root = tree.byId.get(rootId);
  if (!root) return main;
  const author = root.account?.id;

  let cur = root;
  while (cur) {
    main.add(cur.id);
    const kids = tree.children.get(cur.id) || [];
    cur = kids.find((k) => k.account?.id === author);
  }

  let s = tree.byId.get(startId);
  while (s) {
    main.add(s.id);
    s = s.in_reply_to_id ? tree.byId.get(s.in_reply_to_id) : null;
  }
  return main;
}

export function countDescendants(tree, id) {
  let n = 0;
  const stack = [...(tree.children.get(id) || [])];
  while (stack.length) {
    const s = stack.pop();
    n++;
    for (const k of tree.children.get(s.id) || []) stack.push(k);
  }
  return n;
}
