import { parseStatusUrl } from './parse.js';
import { collectThread, buildTree, classifyNodes } from './thread.js';
import { renderThread, renderError } from './render.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const input = $('#url');
const statusLine = $('#status');
const threadEl = $('#thread');
const toolbar = $('#toolbar');
const expandAllBtn = $('#expand-all');
const collapseAllBtn = $('#collapse-all');

let inflight = null;
let currentForks = [];

function setStatus(text, { busy = false } = {}) {
  statusLine.textContent = text;
  statusLine.classList.toggle('busy', busy);
}

function openAll(forks, open) {
  // Opening a fork renders its children lazily, which may add more forks.
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of threadEl.querySelectorAll('details.forks')) {
      if (d.open !== open) { d.open = open; changed = true; }
    }
  }
}

async function load(text, { push = true } = {}) {
  const target = parseStatusUrl(text);
  if (!target) {
    setStatus('');
    threadEl.replaceChildren(renderError('That does not look like a post URL. Paste a link such as https://mastodon.social/@user/1234567890.'));
    return;
  }
  if (push) {
    const u = new URL(location.href);
    u.searchParams.set('url', text.trim());
    history.pushState({ url: text.trim() }, '', u);
  }
  document.title = `${target.host} thread · fedithread`;

  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  threadEl.replaceChildren();
  toolbar.hidden = true;
  setStatus(`Fetching from ${target.host}…`, { busy: true });

  try {
    const result = await collectThread(target.host, target.id, {
      signal: ctrl.signal,
      onProgress: ({ posts, requests, pending }) =>
        setStatus(`Fetched ${posts} post${posts === 1 ? '' : 's'} in ${requests} request${requests === 1 ? '' : 's'}${pending ? `, ${pending} pending` : ''}…`, { busy: true }),
    });
    if (ctrl.signal.aborted) return;

    const tree = buildTree(result.statuses);
    const main = classifyNodes(tree, result.root.id, result.start.id);
    const { element, forks } = renderThread(tree, main, { host: target.host, rootId: result.root.id, startId: result.start.id });
    currentForks = forks;
    threadEl.replaceChildren(element);
    toolbar.hidden = false;

    const notes = [`${result.statuses.length} posts`, `${forks.length} fork${forks.length === 1 ? '' : 's'}`];
    if (tree.orphans) notes.push(`${tree.orphans} unreachable (parent deleted or private)`);
    if (result.missing) notes.push(`about ${result.missing} more ${result.missing === 1 ? 'reply' : 'replies'} not reachable anonymously`);
    if (result.truncated) notes.push('request budget hit, thread may be incomplete');
    setStatus(notes.join(' · '));

    const startEl = document.getElementById(`s-${result.start.id}`);
    if (startEl && result.start.id !== result.root.id) startEl.scrollIntoView({ block: 'center' });
    document.dispatchEvent(new CustomEvent('fedithread:rendered', { detail: { posts: result.statuses.length, forks: forks.length } }));
  } catch (err) {
    if (ctrl.signal.aborted) return;
    console.error(err);
    setStatus('');
    threadEl.replaceChildren(renderError(err.message || String(err)));
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(input.value);
});
expandAllBtn.addEventListener('click', () => openAll(currentForks, true));
collapseAllBtn.addEventListener('click', () => openAll(currentForks, false));

window.addEventListener('popstate', () => {
  const url = new URL(location.href).searchParams.get('url') || '';
  input.value = url;
  if (url) load(url, { push: false });
  else { threadEl.replaceChildren(); toolbar.hidden = true; setStatus(''); }
});

const initial = new URL(location.href).searchParams.get('url');
if (initial) {
  input.value = initial;
  // Top-level await so the page's load event waits for the first render.
  await load(initial, { push: false });
} else {
  input.focus();
}
