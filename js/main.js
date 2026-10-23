import { parseInput, seriesRef } from './parse.js';
import { collectThread, buildTree, classifyNodes, orphanGroups } from './thread.js';
import { renderThread, renderError } from './render.js';
import { getHomeInstance, setHomeInstance, replyUrl } from './settings.js';
import { statusContentHtml } from './sanitize.js';
import { buildExport, toHtml, toMarkdown, suggestedFileName, buildSeriesExport } from './export.js';
import { shareUrl, seriesShareUrl, seriesRoute } from './share.js';
import { createSeries, collectSeries, seriesSnapshot, SERIES_REQUESTS } from './series.js';
import { renderSeries } from './series-render.js';
import { prepareArchive } from './archive.js';
import { createZip } from './zip.js';

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
const shareBtn = $('#share');
const shareRow = $('#share-row');
const shareLink = $('#share-link');
const shareHint = $('#share-hint');
const threadSave = $('#thread-save');
const seriesTools = $('#series-tools');
const discussionInput = $('#series-discussion');
const siteHtmlBtn = $('#save-site-html');
const siteMdBtn = $('#save-site-md');
const buildPanel = $('#build-panel');
const buildPhase = $('#build-phase');
const buildCount = $('#build-count');
const cancelBuild = $('#cancel-build');
const continueBuild = $('#continue-build');
const archiveWarning = $('#archive-warning');
const archiveGaps = $('#archive-gaps');

let inflight = null;
let currentForks = [];
let current = null; // { tree, main, result, host, id } of the rendered thread, for export and share
let shareAttempt = 0;
let pendingArchive = null;

function setStatus(text, { busy = false } = {}) {
  statusLine.textContent = text;
  statusLine.classList.toggle('busy', busy);
}

function resetLoadedState() {
  inflight?.abort();
  inflight = null;
  shareAttempt++;
  currentForks = [];
  current = null;
  pendingArchive = null;
  archiveWarning.hidden = true;
  buildPanel.hidden = true;
  buildPanel.classList.remove('active');
  threadEl.removeAttribute('aria-busy');
  discussionInput.checked = false;
  toolbar.hidden = true;
  shareRow.hidden = true;
  shareLink.value = '';
  shareHint.textContent = '';
  document.title = 'fedithread';
}

function toolbarMode(series) {
  expandAllBtn.hidden = series;
  collapseAllBtn.hidden = series;
  threadSave.hidden = series;
  seriesTools.hidden = !series;
  shareBtn.title = series ? 'Copy the collection address and selected view, without reader settings.' : 'Copy a link that reopens this thread.';
}

function buildActivity(active, phase = '') {
  buildPanel.hidden = !active;
  buildPanel.classList.toggle('active', active);
  threadEl.setAttribute('aria-busy', String(active));
  cancelBuild.hidden = !active;
  continueBuild.hidden = true;
  siteHtmlBtn.disabled = active;
  siteMdBtn.disabled = active;
  if (phase) buildPhase.textContent = phase;
  if (!active) {
    buildCount.textContent = '';
    const state = current?.kind === 'series' ? current.state : null;
    if (state && (state.paused || state.error || state.stage !== 'ready')) {
      buildPanel.hidden = false;
      buildPhase.textContent = state.paused || state.error || 'More content remains to be collected.';
      buildCount.textContent = 'Progress is kept in this tab.';
      continueBuild.hidden = false;
    }
  }
}

function buildProgress(progress) {
  buildPhase.textContent = progress.phase;
  buildCount.textContent = progress.total != null
    ? `${progress.completed} of ${progress.total}`
    : `${progress.matches} tagged posts · ${progress.requests} API requests`;
  setStatus(`${buildPhase.textContent} · ${buildCount.textContent}`, { busy: true });
}

function discussionRoots(session, all = false) {
  if (!discussionInput.checked) return [];
  const ids = seriesSnapshot(session.state).articles.map((a) => a.id);
  if (all || session.route.view === 'all') return ids;
  return session.route.post && ids.includes(session.route.post) ? [session.route.post] : [];
}

function showSeries(session) {
  if (current !== session) return;
  let snapshot;
  try {
    snapshot = seriesSnapshot(session.state, { includeDiscussion: discussionInput.checked, discussionRoots: discussionRoots(session) });
  } catch (err) {
    console.error(err);
    setStatus('The collection could not be reconstructed.');
    threadEl.replaceChildren(renderError(err.message || String(err)));
    toolbar.hidden = true;
    return;
  }
  if (session.route.post && session.state.stage === 'ready' && !snapshot.articles.some((a) => a.id === session.route.post)) {
    session.route = { post: '', view: '', warning: 'That article is not available. Showing the collection index.' };
    history.replaceState({}, '', seriesShareUrl(location.href, session.state.target));
  }
  threadEl.replaceChildren(renderSeries(snapshot, { pageUrl: location.href, route: session.route }));
  refreshReplyLinks();
  toolbar.hidden = false;
  toolbarMode(true);
  siteHtmlBtn.disabled = !snapshot.articles.length;
  siteMdBtn.disabled = !snapshot.articles.length;
  const state = session.state;
  const notes = [`${snapshot.articles.length} articles`, `${state.totalRequests} API requests`];
  if (session.route.warning) notes.push(session.route.warning);
  if (state.paused) notes.push(state.paused);
  if (state.error) notes.push(state.error);
  if (!snapshot.complete) notes.push('collection is incomplete; see notices below');
  setStatus(notes.join(' · '));
  document.title = `${snapshot.title} · fedithread`;
  const pendingDiscussion = discussionRoots(session).some((id) => !state.discussions.get(id)?.done);
  if (state.paused || state.error || state.stage !== 'ready' || pendingDiscussion) {
    buildPanel.hidden = false;
    buildPanel.classList.remove('active');
    buildPhase.textContent = state.paused || state.error || 'More content remains to be collected.';
    buildCount.textContent = 'Progress is kept in this tab.';
    cancelBuild.hidden = true;
    continueBuild.hidden = false;
  }
  document.dispatchEvent(new CustomEvent('fedithread:rendered', { detail: { mode: 'series', articles: snapshot.articles.length, complete: snapshot.complete } }));
}

async function runSeries({ allDiscussion = false } = {}) {
  const session = current;
  if (session?.kind !== 'series') return false;
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  pendingArchive = null;
  archiveWarning.hidden = true;
  cancelBuild.textContent = 'Pause';
  buildActivity(true, 'Gathering pages');
  try {
    const onProgress = (progress) => { if (inflight === ctrl && !ctrl.signal.aborted) buildProgress(progress); };
    await collectSeries(session.state, { signal: ctrl.signal, onProgress });
    const used = session.state.batchRequests;
    const roots = discussionRoots(session, allDiscussion);
    if (session.state.stage === 'ready' && roots.length) {
      await collectSeries(session.state, { signal: ctrl.signal, onProgress, discussionRoots: roots, maxRequests: SERIES_REQUESTS - used });
    }
  } catch (err) {
    if (ctrl.signal.aborted) {
      if (inflight === ctrl && current === session) session.state.paused = 'Paused. Continue to collect the remaining content.';
    }
    else console.error(err);
  } finally {
    if (inflight === ctrl && current === session) {
      inflight = null;
      buildActivity(false);
      showSeries(session);
    }
  }
  return current === session && !ctrl.signal.aborted;
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

async function load(text, { push = true, route = { post: '', view: '', warning: '' } } = {}) {
  // Whatever happens next, the previous thread's tools must not outlive it.
  resetLoadedState();
  const target = parseInput(text);
  if (!target) {
    setStatus('');
    threadEl.replaceChildren(renderError('Paste a post URL such as https://mastodon.social/@user/1234567890 or a collection URL such as https://mastodon.social/@user/tagged/topic.'));
    return;
  }
  if (target.kind === 'series') {
    const canonical = seriesShareUrl(location.href, target, route);
    if (push) history.pushState({}, '', canonical);
    else if (route.warning) history.replaceState({}, '', canonical);
    threadEl.replaceChildren();
    current = { kind: 'series', state: createSeries(target), route, assets: new Map() };
    toolbarMode(true);
    await runSeries();
    return;
  }
  toolbarMode(false);
  if (push) {
    const u = new URL(location.href);
    u.searchParams.set('url', text.trim());
    u.searchParams.delete('post');
    u.searchParams.delete('view');
    history.pushState({ url: text.trim() }, '', u);
  }
  document.title = `${target.host} thread · fedithread`;

  const ctrl = new AbortController();
  inflight = ctrl;
  threadEl.replaceChildren();
  setStatus(`Fetching from ${target.host}…`, { busy: true });

  try {
    const result = await collectThread(target.host, target.id, {
      signal: ctrl.signal,
      onProgress: ({ posts, requests, pending }) => {
        if (inflight !== ctrl || ctrl.signal.aborted) return;
        setStatus(`Fetched ${posts} post${posts === 1 ? '' : 's'} in ${requests} request${requests === 1 ? '' : 's'}${pending ? `, ${pending} pending` : ''}…`, { busy: true });
      },
    });
    if (ctrl.signal.aborted) return;

    const tree = buildTree(result.statuses);
    const main = classifyNodes(tree, result.root.id, result.start.id);
    const { element, forks } = renderThread(tree, main, { host: target.host, rootId: result.root.id, startId: result.start.id });
    currentForks = forks;
    current = { kind: 'thread', tree, main, result, host: target.host, id: target.id };
    threadEl.replaceChildren(element);
    refreshReplyLinks();
    toolbar.hidden = false;

    const notes = [`${result.statuses.length} posts`, `${forks.length} fork${forks.length === 1 ? '' : 's'}`];
    const unplaced = orphanGroups(tree, result.root.id).reduce((n, g) => n + g.replies.length, 0);
    if (unplaced) notes.push(`${unplaced} ${unplaced === 1 ? 'reply' : 'replies'} to posts that could not be fetched, shown at the end`);
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
  homeHint.textContent = home
    ? `Reply links open posts on ${home}.`
    : 'Not required to read. Enter it to get Reply links that open each post in your own account.';
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
  downloadBlob(name, new Blob([text], { type }));
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
function saveThread(format) {
  if (current?.kind !== 'thread') return;
  const { tree, main, result, host } = current;
  const model = buildExport(tree, main, {
    rootId: result.root.id,
    host,
    includeForks: saveForks.checked,
    content: statusContentHtml,
    missing: result.missing,
  });
  if (format === 'html') download(suggestedFileName(model, 'html'), toHtml(model), 'text/html;charset=utf-8');
  else download(suggestedFileName(model, 'md'), toMarkdown(model), 'text/markdown;charset=utf-8');
}
saveHtmlBtn.addEventListener('click', () => saveThread('html'));
saveMdBtn.addEventListener('click', () => saveThread('md'));

async function writeArchive(archive, session, controller = new AbortController()) {
  inflight = controller;
  pendingArchive = null;
  archiveWarning.hidden = true;
  cancelBuild.textContent = 'Cancel';
  buildActivity(true, 'Writing ZIP');
  try {
    const blob = await createZip(archive.files, { signal: controller.signal, onProgress: (p) => {
      if (inflight === controller && !controller.signal.aborted) buildProgress(p);
    } });
    if (current !== session || controller.signal.aborted) return;
    downloadBlob(archive.name, blob);
    setStatus(`Saved ${archive.partial ? 'a labeled partial archive' : 'the collection archive'} as ${archive.name}.`);
  } catch (err) {
    if (!controller.signal.aborted) { console.error(err); setStatus(`Could not save the archive: ${err.message}`); }
    else if (current === session) setStatus('Archive creation cancelled. No download was started.');
  } finally {
    if (inflight === controller) { inflight = null; buildActivity(false); }
  }
}

async function saveSeries(format) {
  const session = current;
  if (session?.kind !== 'series' || inflight) return;
  pendingArchive = null;
  archiveWarning.hidden = true;
  if (discussionInput.checked && session.state.stage === 'ready') {
    if (!await runSeries({ allDiscussion: true })) return;
  }
  if (current !== session) return;
  const ctrl = new AbortController();
  inflight = ctrl;
  cancelBuild.textContent = 'Cancel';
  buildActivity(true, 'Preparing the document tree');
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    ctrl.signal.throwIfAborted();
    const model = buildSeriesExport(seriesSnapshot(session.state, { includeDiscussion: discussionInput.checked }), { content: statusContentHtml });
    const archive = await prepareArchive(model, { format, signal: ctrl.signal, cache: session.assets, onProgress: (p) => {
      if (inflight === ctrl && !ctrl.signal.aborted) buildProgress(p);
    } });
    if (current !== session || ctrl.signal.aborted) return;
    if (archive.partial) {
      pendingArchive = { archive, session, format };
      archiveGaps.replaceChildren(...[...archive.warnings, ...archive.omissions.map((o) => `${o.url}: ${o.reason}`)].map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
      archiveWarning.hidden = false;
      setStatus('The archive has gaps. Review them and explicitly choose whether to save a partial ZIP.');
      $('#confirm-archive').focus();
    } else await writeArchive(archive, session, ctrl);
  } catch (err) {
    if (!ctrl.signal.aborted) { console.error(err); setStatus(`Could not prepare the archive: ${err.message}`); }
    else if (current === session) setStatus('Archive preparation cancelled. No download was started.');
  } finally {
    if (inflight === ctrl) { inflight = null; buildActivity(false); }
  }
}
siteHtmlBtn.addEventListener('click', () => saveSeries('html'));
siteMdBtn.addEventListener('click', () => saveSeries('md'));
$('#confirm-archive').addEventListener('click', () => {
  if (pendingArchive && current === pendingArchive.session && !inflight) writeArchive(pendingArchive.archive, pendingArchive.session);
});
$('#retry-archive').addEventListener('click', () => {
  if (pendingArchive && current === pendingArchive.session) saveSeries(pendingArchive.format);
});
$('#dismiss-archive').addEventListener('click', () => { pendingArchive = null; archiveWarning.hidden = true; });
cancelBuild.addEventListener('click', () => inflight?.abort());
continueBuild.addEventListener('click', () => runSeries());
discussionInput.addEventListener('change', () => runSeries());

// Share: copy a link that reopens this thread, built only from the parsed
// host and id and the author's handle. The home instance, fork state and
// anything else about the reader stay out of it. The clipboard call must
// happen synchronously in the click handler, or Safari drops it.
function share() {
  if (!current) return;
  const attempt = ++shareAttempt;
  const series = current.kind === 'series';
  const url = series
    ? seriesShareUrl(location.href, current.state.target, current.route)
    : shareUrl(location.href, { host: current.host, id: current.id, acct: current.result.start.account?.acct });
  shareLink.value = url || '';
  shareHint.textContent = '';
  shareRow.hidden = false;
  if (!url) { shareHint.textContent = 'Could not build a link for this view.'; return; }
  let copied;
  try { copied = navigator.clipboard.writeText(url); } catch (err) { copied = Promise.reject(err); }
  copied.then(
    () => {
      if (attempt === shareAttempt) shareHint.textContent = series ? 'Copied. The link holds only the collection address and view.' : 'Copied. The link holds only the post address.';
    },
    () => {
      if (attempt !== shareAttempt) return;
      shareLink.focus();
      shareLink.select();
      shareHint.textContent = 'Select and copy this link.';
    },
  );
}
shareBtn.addEventListener('click', share);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  load(input.value);
});
expandAllBtn.addEventListener('click', () => openAll(currentForks, true));
collapseAllBtn.addEventListener('click', () => openAll(currentForks, false));

async function navigate(url, { push = false } = {}) {
  const page = new URL(url);
  const text = page.searchParams.get('url') || '';
  const target = parseInput(text);
  input.value = text;
  if (target?.kind === 'series' && current?.kind === 'series' && seriesRef(target) === seriesRef(current.state.target)) {
    inflight?.abort();
    inflight = null;
    pendingArchive = null;
    archiveWarning.hidden = true;
    shareAttempt++;
    shareRow.hidden = true;
    shareLink.value = '';
    shareHint.textContent = '';
    current.route = seriesRoute(page.href);
    if (push) history.pushState({}, '', page);
    if (current.route.warning) history.replaceState({}, '', seriesShareUrl(page.href, target));
    await runSeries();
    if (location.hash) {
      try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); }
      catch (err) { console.error(err); setStatus('The section link is invalid.'); }
    } else if (push) {
      const heading = threadEl.querySelector('.story h2, .series-header h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' }); }
    }
  } else if (text) await load(text, { push, route: seriesRoute(page.href) });
  else {
    resetLoadedState();
    threadEl.replaceChildren();
    setStatus('');
  }
}
threadEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-series-nav]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.href, { push: true });
});
window.addEventListener('popstate', () => {
  navigate(location.href);
});

const initial = new URL(location.href).searchParams.get('url');
if (initial) {
  input.value = initial;
  // Top-level await so the page's load event waits for the first render.
  await load(initial, { push: false, route: seriesRoute(location.href) });
} else {
  input.focus();
}
