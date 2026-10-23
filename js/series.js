import { ApiError, fetchAccount, fetchAccountStatuses, fetchStatus, fetchContext } from './api.js';
import { buildTree, classifyNodes, contextCandidates, missingReplies } from './thread.js';
import { threadTitle } from './export.js';
import { seriesRef } from './parse.js';

export const SERIES_REQUESTS = 80;
const fold = (text) => String(text).normalize('NFC').toLowerCase();
const byTime = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
const publicStatus = (s) => !s.reblog && (!s.visibility || ['public', 'unlisted'].includes(s.visibility));

function checkStatus(s) {
  if (!s || typeof s.id !== 'string' || !s.id || typeof s.account?.id !== 'string'
      || typeof s.created_at !== 'string' || !Number.isFinite(Date.parse(s.created_at))) {
    throw new ApiError('The instance returned an invalid post.');
  }
}

function checkPage(batch, accountId) {
  if (!Array.isArray(batch)) throw new ApiError('The instance did not return a list of account posts.');
  for (const s of batch) {
    checkStatus(s);
    if (s.account.id !== accountId) throw new ApiError('The instance returned posts from a different account.');
  }
}

function descendants(tree, rootId) {
  const ids = new Set();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of tree.children.get(id) || []) pending.push(child.id);
  }
  return ids;
}

export function groupArticles(statuses, seedIds, authorId, host) {
  const tree = buildTree(statuses.filter((s) => s.account.id === authorId && publicStatus(s)));
  const groups = new Map();
  for (const id of seedIds) {
    let root = tree.byId.get(id);
    if (!root) continue;
    const seen = new Set();
    while (root.in_reply_to_id && tree.byId.has(root.in_reply_to_id)) {
      if (seen.has(root.id)) throw new ApiError('The instance returned a cyclic author thread.');
      seen.add(root.id);
      root = tree.byId.get(root.in_reply_to_id);
    }
    if (!groups.has(root.id)) groups.set(root.id, { root, seeds: [] });
    groups.get(root.id).seeds.push(id);
  }
  return [...groups.values()].sort((a, b) => byTime(a.root, b.root)).map(({ root, seeds }) => {
    const ids = descendants(tree, root.id);
    const ownTree = buildTree([...ids].map((id) => tree.byId.get(id)));
    const main = classifyNodes(ownTree, root.id, root.id);
    for (const seed of seeds) {
      for (const id of classifyNodes(ownTree, root.id, seed)) main.add(id);
      for (const id of classifyNodes(ownTree, seed, seed)) main.add(id);
    }
    return { id: root.id, root, seeds, tree: ownTree, main, title: threadTitle(root, host) };
  });
}

export function createSeries(target) {
  return {
    target, account: null, stage: 'lookup', statuses: new Map(), seeds: new Set(),
    tagCursor: null, authorCursor: null, tagCursors: new Set(), authorCursors: new Set(),
    authorSeen: new Set(), missingParents: new Map(), issues: new Map(),
    contexts: new Map(), discussions: new Map(), totalRequests: 0, batchRequests: 0,
    paused: '', error: '', retryAt: 0, fetchedAt: null,
  };
}

function articleTree(state, article, discussion) {
  const ids = new Set(article.tree.byId.keys());
  if (discussion) for (const id of discussion.ids) ids.add(id);
  return buildTree([...ids].map((id) => {
    const s = state.statuses.get(id);
    // An author-owned entry never adopts somebody else's conversation root.
    return id === article.id ? { ...s, in_reply_to_id: null } : s;
  }).filter(Boolean));
}

export function seriesSnapshot(state, { includeDiscussion = false, discussionRoots = null } = {}) {
  const warnings = [...state.issues].filter(([key]) => includeDiscussion || !key.startsWith('context-')).map(([, value]) => value);
  if (state.stage !== 'ready') warnings.push('Article discovery or reconstruction is not finished.');
  if (state.error && (state.stage !== 'ready' || includeDiscussion)) warnings.push(state.error);
  const articles = state.account ? groupArticles([...state.statuses.values()], state.seeds, state.account.id, state.target.host) : [];
  for (const article of articles) {
    const discussion = includeDiscussion ? state.discussions.get(article.id) : null;
    article.tree = articleTree(state, article, discussion);
    article.notes = [];
    if (article.root.in_reply_to_id) {
      article.notes.push('This entry starts within an earlier conversation; use its original link for context.');
    }
    article.discussionComplete = !!discussion?.done;
    article.missing = discussion?.missing || 0;
    const requested = includeDiscussion && (!discussionRoots || discussionRoots.includes(article.id));
    if (requested && !discussion?.done) article.notes.push('Discussion has not finished loading.');
    if (includeDiscussion && article.missing) article.notes.push(`About ${article.missing} more replies are not reachable anonymously.`);
    if (requested && (!discussion?.done || article.missing)) warnings.push(`${article.title}: discussion is incomplete.`);
  }
  return {
    target: state.target, account: state.account, source: seriesRef(state.target),
    title: `${state.account?.display_name || state.target.acct} / #${state.target.tag}`,
    articles, warnings: [...new Set(warnings)], complete: state.stage === 'ready' && warnings.length === 0,
    includeDiscussion, fetchedAt: state.fetchedAt, requests: state.totalRequests,
  };
}

class Pause extends Error {}

export async function collectSeries(state, { signal, onProgress = () => {}, maxRequests = SERIES_REQUESTS, discussionRoots = [] } = {}) {
  state.batchRequests = 0;
  state.paused = '';
  state.error = '';
  const { host } = state.target;
  const report = (phase) => onProgress({ phase, matches: state.seeds.size, posts: state.statuses.size, requests: state.totalRequests });
  const request = async (phase, fn) => {
    signal?.throwIfAborted();
    if (state.retryAt > Date.now()) throw new Pause(`Rate limited. Continue after ${new Date(state.retryAt).toLocaleString()}.`);
    if (state.batchRequests >= maxRequests) throw new Pause('Request budget reached. Continue to collect the remaining content.');
    state.batchRequests++;
    state.totalRequests++;
    report(phase);
    const result = await fn();
    signal?.throwIfAborted();
    return result;
  };
  const add = (s) => { if (publicStatus(s)) state.statuses.set(s.id, s); };
  const nextCursor = (batch, cursor, seen) => {
    const next = batch.at(-1).id;
    if (next === cursor || seen.has(next)) throw new ApiError('Account pagination did not advance. The collection is incomplete; try rebuilding later.');
    seen.add(next);
    return next;
  };
  try {
    if (state.stage === 'lookup') {
      const account = await request('Finding the author', () => fetchAccount(host, state.target.acct, { signal }));
      const full = (acct) => fold(acct.includes('@') ? acct : `${acct}@${host}`);
      if (typeof account?.id !== 'string' || !account.id || typeof account.acct !== 'string' || !account.acct || full(account.acct) !== full(state.target.acct)) {
        throw new ApiError('The instance did not resolve the requested author.');
      }
      state.account = account;
      state.stage = 'tags';
    }
    while (state.stage === 'tags') {
      const batch = await request('Discovering tagged posts', () => fetchAccountStatuses(host, state.account.id, {
        tagged: state.target.tag, exclude_reblogs: true, limit: 40, max_id: state.tagCursor,
      }, { signal }));
      checkPage(batch, state.account.id);
      if (!batch.length) { state.stage = state.seeds.size ? 'author' : 'ready'; break; }
      if (batch.some((s) => !publicStatus(s) || !(s.tags || []).some((t) => typeof t?.name === 'string' && fold(t.name) === fold(state.target.tag)))) {
        throw new ApiError('The instance did not apply the author/tag filter. This collection cannot be read reliably here.');
      }
      const cursor = nextCursor(batch, state.tagCursor, state.tagCursors);
      for (const s of batch) { add(s); state.seeds.add(s.id); }
      state.tagCursor = cursor;
    }
    while (state.stage === 'author') {
      const batch = await request('Recovering author continuations', () => fetchAccountStatuses(host, state.account.id, {
        exclude_reblogs: true, limit: 40, max_id: state.authorCursor,
      }, { signal }));
      checkPage(batch, state.account.id);
      if (!batch.length) {
        if ([...state.seeds].some((id) => !state.authorSeen.has(id))) {
          state.issues.set('timeline', 'The author timeline ended before all tagged posts were encountered; some continuations may be unavailable.');
        }
        state.stage = 'parents';
        break;
      }
      const cursor = nextCursor(batch, state.authorCursor, state.authorCursors);
      for (const s of batch) { add(s); state.authorSeen.add(s.id); }
      state.authorCursor = cursor;
      if ([...state.seeds].every((id) => state.authorSeen.has(id))) state.stage = 'parents';
    }
    if (state.stage === 'parents') {
      for (const id of state.seeds) {
        let s = state.statuses.get(id);
        const seen = new Set();
        while (s?.in_reply_to_id) {
          if (seen.has(s.id)) throw new ApiError('The instance returned a cyclic author thread.');
          seen.add(s.id);
          if (s.in_reply_to_account_id && s.in_reply_to_account_id !== state.account.id) break;
          const parentId = s.in_reply_to_id;
          if (state.missingParents.has(parentId)) break;
          let parent = state.statuses.get(parentId);
          if (!parent) {
            try {
              parent = await request('Recovering earlier posts', () => fetchStatus(host, parentId, { signal }));
              checkStatus(parent);
              if (parent.id !== parentId) throw new ApiError('The instance returned a different parent post.');
              if (!publicStatus(parent)) throw new ApiError('An earlier post is not publicly accessible.');
              add(parent);
            } catch (err) {
              if (signal?.aborted) throw err;
              if (!(err instanceof ApiError) || ![404, 410].includes(err.status)) throw err;
              state.missingParents.set(parentId, err.message);
              state.issues.set(`parent-${parentId}`, `Earlier post ${parentId} is unavailable; its article may be incomplete.`);
              break;
            }
          }
          if (parent.account.id !== state.account.id) break;
          s = parent;
        }
      }
      state.stage = 'ready';
    }
    if (state.stage === 'ready') {
      state.fetchedAt ||= new Date().toISOString();
      const articles = groupArticles([...state.statuses.values()], state.seeds, state.account.id, host);
      for (const rootId of discussionRoots) {
        const article = articles.find((a) => a.id === rootId);
        if (!article) throw new ApiError('The requested article is not in this collection.');
        if (!state.discussions.has(rootId)) state.discussions.set(rootId, { ids: new Set(), expanded: new Set(), done: false, missing: 0 });
        const discussion = state.discussions.get(rootId);
        if (discussion.done) continue;
        for (;;) {
          const tree = articleTree(state, article, discussion);
          const todo = discussion.expanded.has(rootId) ? contextCandidates(tree, discussion.expanded) : [article.root];
          if (!todo.length) {
            discussion.done = true;
            discussion.missing = missingReplies(tree, discussion.expanded);
            break;
          }
          const id = todo[0].id;
          let ctx = state.contexts.get(id);
          try {
            if (!ctx) {
              ctx = await request('Collecting discussion', () => fetchContext(host, id, { signal }));
              if (!Array.isArray(ctx?.ancestors) || !Array.isArray(ctx.descendants)) throw new ApiError('The instance returned an invalid discussion.');
              for (const s of [...ctx.ancestors, ...ctx.descendants]) checkStatus(s);
              state.contexts.set(id, ctx);
            }
            for (const s of ctx.descendants) {
              if (!publicStatus(s)) continue;
              add(s);
              discussion.ids.add(s.id);
            }
          } catch (err) {
            if (signal?.aborted) throw err;
            if (!(err instanceof ApiError) || ![404, 410].includes(err.status)) throw err;
            state.issues.set(`context-${id}`, `Discussion for post ${id} is unavailable.`);
          }
          discussion.expanded.add(id);
        }
      }
    }
    report(state.stage === 'ready' ? 'Ready to read' : 'Paused');
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof Pause) {
      state.paused = err.message;
    } else {
      state.error = err.message || String(err);
      if (err.retryAt) state.retryAt = err.retryAt;
      throw err;
    }
  }
  return state;
}
