import { parseStatusUrl } from './parse.js';
import { collectThread, buildTree, classifyNodes } from './thread.js';
import { renderThread, renderError } from './render.js';
import { getHomeInstance, setHomeInstance, replyUrl } from './settings.js';
import { statusContentHtml } from './sanitize.js';
import { buildExport, toHtml, toMarkdown, suggestedFileName } from './export.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const input = $('#url');
const statusLine = $('#status');
const threadEl = $('#thread');
const toolbar = $('#toolbar');
const expandAllBtn = $('#expand-all');
const collapseAllBtn = $('#collapse-all');
const homeInput = $('#home');
const homeHint = $('#home-hint');
const saveHtmlBtn = $('#save-html');
const saveMdBtn = $('#save-md');
const saveForks = $('#save-forks');

let inflight = null;
let currentForks = [];
let current = null; // { tree, main, result, host } of the rendered thread, for export

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
  current = null;
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
    current = { tree, main, result, host: target.host };
    threadEl.replaceChildren(element);
    refreshReplyLinks();
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

// Home instance: stored locally, used to build every card's Reply link.
function refreshReplyLinks() {
  const home = getHomeInstance();
  for (const a of threadEl.querySelectorAll('a.reply')) {
    a.href = replyUrl(home, { uri: a.dataset.uri }) || '#';
  }
  homeHint.textContent = home ? '' : 'Set this to make Reply open a post in your own account.';
}
homeInput.value = getHomeInstance();
homeInput.addEventListener('change', () => {
  const host = setHomeInstance(homeInput.value);
  homeInput.value = host;
  homeInput.classList.remove('attention');
  refreshReplyLinks();
});
threadEl.addEventListener('click', (e) => {
  const a = e.target.closest('a.reply');
  if (!a) return;
  if (getHomeInstance()) return; // href is already the remote-interaction URL
  e.preventDefault();
  homeInput.classList.add('attention');
  homeInput.scrollIntoView({ block: 'center' });
  homeInput.focus();
  homeHint.textContent = 'Enter your instance first, then Reply will open there.';
});
refreshReplyLinks();

// Save the thread as a file. The document is built from the same tree and
// main-line set as the page, so it matches what is on screen.
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
function saveThread(format) {
  if (!current) return;
  const { tree, main, result, host } = current;
  const model = buildExport(tree, main, {
    rootId: result.root.id,
    host,
    includeForks: saveForks.checked,
    content: statusContentHtml,
    missing: result.missing,
    orphans: tree.orphans,
  });
  if (format === 'html') download(suggestedFileName(model, 'html'), toHtml(model), 'text/html;charset=utf-8');
  else download(suggestedFileName(model, 'md'), toMarkdown(model), 'text/markdown;charset=utf-8');
}
saveHtmlBtn.addEventListener('click', () => saveThread('html'));
saveMdBtn.addEventListener('click', () => saveThread('md'));

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
  else { threadEl.replaceChildren(); toolbar.hidden = true; current = null; setStatus(''); }
});

const initial = new URL(location.href).searchParams.get('url');
if (initial) {
  input.value = initial;
  // Top-level await so the page's load event waits for the first render.
  await load(initial, { push: false });
} else {
  input.focus();
}
