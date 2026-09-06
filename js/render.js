import { sanitizeHtml, applyCustomEmoji, textWithEmoji } from './sanitize.js';
import { countDescendants, orphanGroups, findAccount } from './thread.js';
import { getHomeInstance, replyUrl } from './settings.js';

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

const fmtTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const fmtCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));

function handleOf(account, host) {
  const acct = account?.acct || '';
  return acct.includes('@') ? `@${acct}` : `@${acct}@${host}`;
}

function renderMedia(status) {
  const items = status.media_attachments || [];
  if (items.length === 0) return null;
  const grid = h('div', { class: `media media-${Math.min(items.length, 4)}` });
  for (const m of items) {
    const alt = m.description || '';
    let el;
    if (m.type === 'image') {
      el = h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' },
        h('img', { src: m.preview_url || m.url, alt, title: alt, loading: 'lazy' }));
    } else if (m.type === 'gifv' || m.type === 'video') {
      el = h('video', { src: m.url, poster: m.preview_url, controls: true, loop: m.type === 'gifv', muted: m.type === 'gifv', playsinline: true, preload: 'none', title: alt });
    } else if (m.type === 'audio') {
      el = h('audio', { src: m.url, controls: true, preload: 'none', title: alt });
    } else {
      el = h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, m.type || 'attachment');
    }
    const wrap = h('div', { class: 'media-item' }, el);
    if (status.sensitive) {
      wrap.classList.add('sensitive');
      const btn = h('button', { class: 'reveal', type: 'button' }, 'Sensitive media, click to show');
      btn.addEventListener('click', () => { wrap.classList.remove('sensitive'); btn.remove(); });
      wrap.append(btn);
    }
    grid.append(wrap);
  }
  return grid;
}

function renderPoll(poll) {
  if (!poll) return null;
  const total = poll.voters_count ?? poll.votes_count ?? 0;
  const list = h('ul', { class: 'poll' });
  for (const opt of poll.options || []) {
    const votes = opt.votes_count ?? 0;
    const pct = total ? Math.round((100 * votes) / total) : 0;
    list.append(h('li', {},
      h('span', { class: 'poll-bar', style: `width:${pct}%` }),
      h('span', { class: 'poll-label' }, `${opt.title} `, h('small', {}, `${pct}% (${votes})`))));
  }
  return h('div', {}, list, h('small', { class: 'muted' }, `${total} vote${total === 1 ? '' : 's'}${poll.expired ? ', closed' : ''}`));
}

function renderCard(status, { host, isStart }) {
  const acct = status.account || {};
  const content = applyCustomEmoji(sanitizeHtml(status.content), status.emojis);
  const body = h('div', { class: 'body' }, h('div', { class: 'content' }, content), renderMedia(status), renderPoll(status.poll));

  const card = h('article', { class: `card${isStart ? ' start' : ''}`, id: `s-${status.id}` },
    h('header', {},
      h('a', { href: acct.url, target: '_blank', rel: 'noopener noreferrer', class: 'avatar-link' },
        h('img', { class: 'avatar', src: acct.avatar_static || acct.avatar, alt: '', loading: 'lazy' })),
      h('div', { class: 'who' },
        h('a', { class: 'name', href: acct.url, target: '_blank', rel: 'noopener noreferrer' }, textWithEmoji(acct.display_name || acct.username, acct.emojis)),
        h('span', { class: 'handle' }, handleOf(acct, host))),
      h('a', { class: 'time', href: status.url || status.uri, target: '_blank', rel: 'noopener noreferrer', title: status.created_at }, fmtTime(status.created_at))),
  );

  if (status.spoiler_text) {
    body.hidden = true;
    const btn = h('button', { class: 'cw', type: 'button', 'aria-expanded': 'false' },
      h('span', { class: 'cw-label' }, 'CW: '), textWithEmoji(status.spoiler_text, status.emojis), h('span', { class: 'cw-toggle' }, ' Show'));
    btn.addEventListener('click', () => {
      body.hidden = !body.hidden;
      btn.setAttribute('aria-expanded', String(!body.hidden));
      btn.querySelector('.cw-toggle').textContent = body.hidden ? ' Show' : ' Hide';
    });
    card.append(btn);
  }
  card.append(body);

  card.append(h('footer', {},
    h('span', { title: 'Replies' }, '↩ ', fmtCount(status.replies_count)),
    h('span', { title: 'Boosts' }, '🔁 ', fmtCount(status.reblogs_count)),
    h('span', { title: 'Favourites' }, '★ ', fmtCount(status.favourites_count)),
    status.visibility && status.visibility !== 'public' ? h('span', { class: 'muted' }, status.visibility) : null,
    status.edited_at ? h('span', { class: 'muted', title: status.edited_at }, 'edited') : null,
    h('span', { class: 'actions' },
      h('a', { class: 'reply', href: replyUrl(getHomeInstance(), status) || '#', dataset: { uri: status.uri || status.url || '' }, target: '_blank', rel: 'noopener noreferrer', title: 'Reply from your own instance' }, 'Reply'),
      h('a', { class: 'open', href: status.url || status.uri, target: '_blank', rel: 'noopener noreferrer' }, 'Open ↗')),
  ));
  return card;
}

// A stand-in for a post we could not fetch: deleted, private, or not visible
// from the instance we asked. `account` is the author when we know them.
function renderPlaceholder({ account, host, kind }) {
  const who = account ? h('span', { class: 'handle' }, handleOf(account, host)) : null;
  const title = kind === 'ancestor' ? 'Earlier post not available' : 'Post not available';
  return h('article', { class: 'card placeholder', role: 'note' },
    h('header', {},
      h('div', { class: 'avatar avatar-missing', 'aria-hidden': 'true' }, '?'),
      h('div', { class: 'who' }, h('span', { class: 'name' }, title), who)),
    h('div', { class: 'content muted' },
      kind === 'ancestor'
        ? `The post this thread starts from is a reply, but its parent could not be fetched from ${host}. It may be deleted, private, or beyond the anonymous ancestor limit.`
        : `The replies below answer a post that could not be fetched from ${host}. It may be deleted, private, or not visible anonymously.`));
}

// Render the tree. Main-line children go inline; fork children are grouped
// under a collapsed toggle that renders lazily on first expand. Replies whose
// parent is missing go under a placeholder card at the end.
export function renderThread(tree, main, { host, rootId, startId }) {
  const container = h('div', { class: 'thread' });
  const forks = [];

  const forkGroup = (forkKids, depth) => {
    const total = forkKids.reduce((n, k) => n + 1 + countDescendants(tree, k.id), 0);
    const authors = [...new Set(forkKids.map((k) => handleOf(k.account, host)))];
    const shown = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ` and ${authors.length - 3} more` : '');
    const label = `${total} ${total === 1 ? 'reply' : 'replies'} from ${shown}`;
    const details = h('details', { class: 'forks' }, h('summary', {}, label));
    const inner = h('div', { class: 'fork-children' });
    details.append(inner);
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (details.open && !rendered) {
        rendered = true;
        for (const k of forkKids) inner.append(renderNode(k, depth + 1));
      }
    });
    forks.push(details);
    return details;
  };

  // Children of one parent: fork group first, then main-line children inline.
  const renderChildren = (kids, depth) => {
    const out = [];
    const forkKids = kids.filter((k) => !main.has(k.id));
    if (forkKids.length) out.push(forkGroup(forkKids, depth));
    for (const k of kids) if (main.has(k.id)) out.push(renderNode(k, depth));
    return out;
  };

  const renderNode = (status, depth) => {
    const wrap = h('div', { class: `node${main.has(status.id) ? ' main' : ' fork'}` });
    wrap.append(renderCard(status, { host, isStart: status.id === startId }));
    wrap.append(...renderChildren(tree.children.get(status.id) || [], depth));
    return wrap;
  };

  const root = tree.byId.get(rootId);
  if (root.in_reply_to_id) {
    container.append(h('div', { class: 'node fork' }, renderPlaceholder({ account: findAccount(tree, root.in_reply_to_account_id), host, kind: 'ancestor' })));
  }
  container.append(renderNode(root, 0));

  const orphans = orphanGroups(tree, rootId);
  if (orphans.length) {
    const section = h('section', { class: 'unplaced' },
      h('h2', {}, `Replies to posts that could not be fetched`));
    for (const g of orphans) {
      const wrap = h('div', { class: 'node fork' });
      wrap.append(renderPlaceholder({ account: findAccount(tree, g.accountId), host, kind: 'missing' }));
      wrap.append(...renderChildren(g.replies, 0));
      section.append(wrap);
    }
    container.append(section);
  }
  return { element: container, forks };
}

export function renderError(message) {
  return h('div', { class: 'error', role: 'alert' }, message);
}
