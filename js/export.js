// Export a collected thread as a standalone HTML page or a Markdown document,
// laid out like a blog entry: the main line is the article, forks are the
// replies section. Pure: no DOM, no network. Status content arrives as
// already-sanitised HTML strings (see statusContentHtml in sanitize.js) and is
// re-parsed here with a small tokenizer that only has to cope with the
// well-formed, allowlisted markup our sanitiser emits.

import { orphanGroups, findAccount } from './thread.js';

const PROJECT_URL = 'https://github.com/xjamesmorris/fedithread';

// ---------------------------------------------------------------- HTML parsing

const VOID = new Set(['br', 'img', 'hr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// -> [{ text }] | [{ tag, attrs, children }]
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|<!--[\s\S]*?-->|([^<]+|<)/g;
  let m;
  while ((m = re.exec(html || ''))) {
    if (m[1]) {
      const i = stack.findLastIndex((n) => n.tag === m[1].toLowerCase());
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? '');
      const el = { tag: m[2].toLowerCase(), attrs, children: [] };
      stack.at(-1).children.push(el);
      if (!VOID.has(el.tag)) stack.push(el);
    } else if (m[4] !== undefined) {
      stack.at(-1).children.push({ text: decodeEntities(m[4]) });
    }
  }
  return root.children;
}

const classes = (n) => new Set((n.attrs?.class || '').split(/\s+/).filter(Boolean));
const isEmoji = (n) => n.tag === 'img' && classes(n).has('emoji');
const BLOCK = new Set(['p', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// Plain text of parsed nodes: hidden link parts dropped, emoji as shortcodes.
export function textOf(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.text != null) { s += n.text; continue; }
    if (classes(n).has('invisible')) continue;
    if (n.tag === 'br') { s += '\n'; continue; }
    if (n.tag === 'img') { s += n.attrs.alt || ''; continue; }
    s += textOf(n.children);
    if (classes(n).has('ellipsis')) s += '…';
    if (BLOCK.has(n.tag)) s += '\n';
  }
  return s;
}

export const htmlToText = (html) => textOf(parseHtml(html)).replace(/\n{2,}/g, '\n').trim();

// ------------------------------------------------------------ HTML -> Markdown

function escapeMd(text) {
  return text
    .replace(/[\\`*[\]<]/g, '\\$&')
    .replace(/(?<!\w)_|_(?!\w)/g, '\\_')
    .replace(/~~/g, '\\~\\~')
    .replace(/^([ \t]*)([#>+-]|\d+[.)])(?=\s)/gm, '$1\\$2');
}

const mdUrl = (u) => String(u || '').replace(/[ ()<>]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

function codeSpan(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(text) || longest ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function codeBlock(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `\n\n${fence}\n${text.replace(/\n$/, '')}\n${fence}\n\n`;
}

const wrap = (mark, inner) => {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
};

function mdNodes(nodes, ctx = {}) {
  return nodes.map((n) => mdNode(n, ctx)).join('');
}

function mdNode(n, ctx) {
  if (n.text != null) return ctx.pre ? n.text : escapeMd(n.text);
  const c = classes(n);
  if (c.has('invisible')) return '';
  const inner = () => mdNodes(n.children, ctx) + (c.has('ellipsis') ? '…' : '');
  switch (n.tag) {
    case 'br': return ctx.pre ? '\n' : '\\\n';
    case 'p': return `\n\n${inner().trim()}\n\n`;
    case 'a': {
      const text = inner();
      const href = n.attrs.href;
      if (!href) return text;
      if (ctx.pre) return text;
      return `[${text || href}](${mdUrl(href)})`;
    }
    case 'strong': case 'b': return wrap('**', inner());
    case 'em': case 'i': return wrap('*', inner());
    case 's': case 'del': return wrap('~~', inner());
    case 'code': return ctx.pre ? inner() : codeSpan(textOf(n.children));
    case 'pre': return codeBlock(textOf(n.children));
    case 'blockquote': {
      const body = mdNodes(n.children, ctx).replace(/\n{3,}/g, '\n\n').trim();
      return `\n\n${body.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n`;
    }
    case 'ul': case 'ol': {
      const items = n.children.filter((k) => k.tag === 'li');
      const lines = items.map((li, i) => {
        const marker = n.tag === 'ol' ? `${i + 1}. ` : '- ';
        const body = mdNodes(li.children, ctx).replace(/\n{3,}/g, '\n\n').trim();
        return marker + body.split('\n').join('\n' + ' '.repeat(marker.length));
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      // The document owns h1 and h2, so post headings start at h3.
      const level = Math.min(6, Number(n.tag[1]) + (ctx.headingOffset ?? 2));
      return `\n\n${'#'.repeat(level)} ${inner().trim()}\n\n`;
    }
    case 'img': return isEmoji(n) && !ctx.emojiImages ? (n.attrs.alt || '') : `![${escapeMd(n.attrs.alt || '')}](${mdUrl(n.attrs.src)})`;
    default: return inner();
  }
}

export function htmlToMarkdown(html, options = {}) {
  return mdNodes(parseHtml(html), options).replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------ HTML -> clean HTML

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const KEEP = new Set(['p', 'strong', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sup', 'sub']);
const RENAME = { b: 'strong', i: 'em' };

function htmlNodes(nodes) {
  return nodes.map(htmlNode).join('');
}

function htmlNode(n) {
  if (n.text != null) return escHtml(n.text);
  const c = classes(n);
  if (c.has('invisible')) return '';
  const inner = htmlNodes(n.children) + (c.has('ellipsis') ? '…' : '');
  if (n.tag === 'br') return '<br>';
  if (n.tag === 'a') return n.attrs.href ? `<a href="${escHtml(n.attrs.href)}">${inner}</a>` : inner;
  if (n.tag === 'img') {
    if (!isEmoji(n)) return `<img src="${escHtml(n.attrs.src)}" alt="${escHtml(n.attrs.alt)}">`;
    return `<img class="emoji" src="${escHtml(n.attrs.src)}" alt="${escHtml(n.attrs.alt)}" title="${escHtml(n.attrs.alt)}">`;
  }
  const tag = RENAME[n.tag] || n.tag;
  if (!KEEP.has(tag)) return inner;
  return `<${tag}>${inner}</${tag}>`;
}

export function cleanHtml(html) {
  return htmlNodes(parseHtml(html));
}

// ------------------------------------------------------------------- the model

// Names and titles are plain text, so known custom emoji shortcodes are dropped.
const stripShortcodes = (text, emojis) => {
  const known = new Set((emojis || []).map((e) => e.shortcode));
  return String(text || '').replace(/:([a-zA-Z0-9_]+):/g, (m, sc) => (known.has(sc) ? '' : m)).replace(/\s{2,}/g, ' ').trim();
};

function handleOf(account, host) {
  const acct = account?.acct || '';
  return acct.includes('@') ? `@${acct}` : `@${acct}@${host}`;
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};

export function threadTitle(root, host) {
  const first = htmlToText(root.spoiler_text ? root.spoiler_text : root.content).split('\n').find((l) => l.trim()) || '';
  let t = stripShortcodes(first.replace(/\s+/g, ' '), root.emojis);
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '') + '…';
  return t || `Thread by ${handleOf(root.account, host)}`;
}

function pollOf(poll) {
  if (!poll) return null;
  const total = poll.voters_count ?? poll.votes_count ?? 0;
  return {
    total,
    expired: !!poll.expired,
    options: (poll.options || []).map((o) => {
      const votes = o.votes_count ?? 0;
      return { title: o.title, votes, pct: total ? Math.round((100 * votes) / total) : 0 };
    }),
  };
}

function postOf(status, host, content) {
  const acct = status.account || {};
  return {
    id: status.id,
    parentId: status.in_reply_to_id || null,
    accountId: acct.id || '',
    url: status.url || status.uri || '',
    uri: status.uri || '',
    date: fmtDate(status.created_at),
    iso: status.created_at,
    author: { name: stripShortcodes(acct.display_name, acct.emojis) || acct.username || '', handle: handleOf(acct, host), url: acct.url || '' },
    html: content(status),
    cw: status.spoiler_text || '',
    media: (status.media_attachments || []).map((m) => ({ type: m.type || 'attachment', url: m.url || m.remote_url || '', alt: m.description || '', sensitive: !!status.sensitive })),
    poll: pollOf(status.poll),
    visibility: status.visibility && status.visibility !== 'public' ? status.visibility : '',
    edited: !!status.edited_at,
  };
}

// Walk the tree in the same order as the page: main-line posts in sequence,
// each followed by its fork subtrees (depth first). Forks are collected flat
// with a depth and a replyTo pointer, so each format can nest or link.
export function buildExport(tree, main, { rootId, host, includeForks = true, content, missing = 0 }) {
  const root = tree.byId.get(rootId);
  if (!root) throw new Error('root status missing');
  const posts = [];
  const replies = [];

  const replyTarget = (status) => ({
    id: status.id,
    name: stripShortcodes(status.account?.display_name, status.account?.emojis) || status.account?.username || '',
    url: status.url || status.uri || '',
  });
  const collectForks = (status, depth) => {
    for (const k of tree.children.get(status.id) || []) {
      replies.push({
        ...postOf(k, host, content),
        depth,
        replyTo: replyTarget(status),
      });
      collectForks(k, depth + 1);
    }
  };
  const walkMain = (status) => {
    posts.push(postOf(status, host, content));
    const kids = tree.children.get(status.id) || [];
    if (includeForks) {
      for (const k of kids) {
        if (main.has(k.id)) continue;
        replies.push({
          ...postOf(k, host, content),
          depth: 0,
          replyTo: replyTarget(status),
        });
        collectForks(k, 1);
      }
    }
    for (const k of kids) if (main.has(k.id)) walkMain(k);
  };
  walkMain(root);

  // Replies whose parent we never fetched, after the forks, under a
  // "missing post" marker instead of a link.
  const orphans = orphanGroups(tree, rootId);
  let unplaced = 0;
  if (includeForks) {
    for (const g of orphans) {
      const author = findAccount(tree, g.accountId);
      const replyTo = { id: g.parentId, name: author ? `a post by ${stripShortcodes(author.display_name, author.emojis) || author.username || ''}`.trim() : 'a post', url: '', missing: true };
      for (const o of g.replies) {
        unplaced++;
        replies.push({ ...postOf(o, host, content), depth: 0, replyTo });
        collectForks(o, 1);
      }
    }
  } else {
    unplaced = orphans.reduce((n, g) => n + g.replies.length, 0);
  }

  const rootPost = posts[0];
  let origin = host;
  try { origin = new URL(rootPost.url).host || host; } catch { /* keep the queried host */ }
  const notes = [];
  if (missing) notes.push(`about ${missing} more ${missing === 1 ? 'reply was' : 'replies were'} not reachable anonymously`);
  if (unplaced) notes.push(`${unplaced} ${unplaced === 1 ? 'reply answers a post' : 'replies answer posts'} that could not be fetched`);
  return {
    title: threadTitle(root, host),
    author: rootPost.author,
    date: rootPost.date,
    iso: rootPost.iso,
    url: rootPost.url,
    host: origin,
    via: origin === host ? '' : host,
    posts,
    replies,
    includeForks,
    notes,
  };
}

function paragraphBlocks(html) {
  const out = [];
  let inline = [];
  const flush = () => {
    if (inline.some((n) => n.text == null || n.text.trim())) out.push({ tag: 'p', attrs: {}, children: inline });
    inline = [];
  };
  for (const node of parseHtml(html)) {
    if (BLOCK.has(node.tag)) { flush(); out.push(node); }
    else inline.push(node);
  }
  flush();
  return out;
}

const PROSE_INLINE = new Set(['p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sup', 'sub']);

function edgeProse(node, end) {
  if (node.text != null) return node.text.trim() ? node : undefined;
  if (classes(node).has('invisible')) return undefined;
  if (!PROSE_INLINE.has(node.tag) || classes(node).has('ellipsis')) return null;
  for (const child of end ? [...node.children].reverse() : node.children) {
    const edge = edgeProse(child, end);
    if (edge !== undefined) return edge;
  }
  return undefined;
}

function trimProseEdge(node, end) {
  if (node.text != null) {
    node.text = end ? node.text.trimEnd() : node.text.trimStart();
    return !!node.text;
  }
  if (classes(node).has('invisible')) return false;
  if (!PROSE_INLINE.has(node.tag)) return true;
  for (const child of end ? [...node.children].reverse() : node.children) {
    if (trimProseEdge(child, end)) return true;
  }
  return false;
}

// Input uses the same already-sanitised HTML contract as buildExport.
export function joinContinuationPosts(posts) {
  const groups = [];
  for (const post of posts) {
    const previous = groups.at(-1);
    const last = previous?.sourcePosts.at(-1);
    const sameAuthor = last && (last.accountId
      ? last.accountId === post.accountId
      : last.author?.handle && last.author.handle === post.author?.handle);
    const canJoin = last && post.parentId === last.id && sameAuthor
      && last.cw === post.cw && !last.media.length && !post.media.length && !last.poll && !post.poll;
    const nodes = paragraphBlocks(post.html);
    if (!canJoin) {
      groups.push({ ...post, nodes, sourcePosts: [post] });
      continue;
    }
    const left = previous.nodes.at(-1);
    const right = nodes[0];
    const tail = left?.tag === 'p' ? edgeProse(left, true) : null;
    const head = right?.tag === 'p' ? edgeProse(right, false) : null;
    const end = tail?.text.match(/(?:\.{3}|\u2026)\s*$/u);
    const start = head?.text.match(/^\s*(?:\.{3}|\u2026)/u);
    if (end && start) {
      tail.text = tail.text.slice(0, end.index).trimEnd();
      head.text = head.text.slice(start[0].length).trimStart();
      trimProseEdge(left, true);
      trimProseEdge(right, false);
      if (textOf(left.children).trim() && textOf(right.children).trim()) left.children.push({ text: ' ' });
      left.children.push(...right.children);
      nodes.shift();
    }
    previous.nodes.push(...nodes);
    previous.sourcePosts.push(post);
  }
  return groups.map(({ nodes, ...group }) => ({ ...group, html: htmlNodes(nodes) }));
}

export function suggestedFileName(model, ext) {
  const slug = model.title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return `${slug || `thread-${model.posts[0]?.id || 'export'}`}.${ext}`;
}

// -------------------------------------------------------------------- Markdown

function mdMedia(m) {
  if (!m.url) return m.unavailable ? `*${escapeMd(m.unavailable)}*` : '';
  const label = m.alt || m.type;
  if (m.type === 'image' && !m.sensitive && !m.linked) return `![${escapeMd(m.alt)}](${mdUrl(m.url)})`;
  const kind = m.linked ? `${m.sensitive ? 'Sensitive image' : 'Image'} not bundled` : m.sensitive ? `Sensitive ${m.type}` : m.type[0].toUpperCase() + m.type.slice(1);
  return `[${kind}${m.alt ? `: ${escapeMd(label)}` : ''}](${mdUrl(m.url)})`;
}

function mdPoll(poll) {
  if (!poll) return '';
  const lines = poll.options.map((o) => `- ${escapeMd(o.title)} — ${o.pct}% (${o.votes})`);
  lines.push(`\n*${poll.total} vote${poll.total === 1 ? '' : 's'}${poll.expired ? ', closed' : ''}*`);
  return lines.join('\n');
}

function mdPostBody(p, options) {
  const parts = [];
  if (p.cw) parts.push(`**CW: ${escapeMd(p.cw)}**`);
  const body = htmlToMarkdown(p.html, options);
  if (body) parts.push(body);
  const media = p.media.map(mdMedia).filter(Boolean);
  if (media.length) parts.push(media.join('\n\n'));
  if (p.poll) parts.push(mdPoll(p.poll));
  return parts.join('\n\n');
}

const mdWho = (p) => `**${escapeMd(p.author.name || p.author.handle)}** ${escapeMd(p.author.handle)}`;

function mdMeta(p, { showAuthor, replyTo }) {
  const bits = [];
  if (showAuthor) bits.push(mdWho(p));
  bits.push(p.url ? `[${p.date}](${mdUrl(p.url)})` : p.date);
  if (replyTo?.missing) bits.push(`replying to ${escapeMd(replyTo.name)} that could not be fetched`);
  else if (replyTo) bits.push(replyTo.url ? `replying to [${escapeMd(replyTo.name)}](${mdUrl(replyTo.url)})` : `replying to ${escapeMd(replyTo.name)}`);
  if (p.visibility) bits.push(p.visibility);
  if (p.edited) bits.push('edited');
  return `<sub>${bits.join(' · ')}</sub>`;
}

export function toMarkdown(model, { frontMatter = true, headingLevel = 1, emojiImages = false, navigation = '', joinContinuations = false } = {}) {
  const out = [];
  if (frontMatter) {
    out.push('---');
    out.push(`title: ${JSON.stringify(model.title)}`);
    out.push(`author: ${JSON.stringify(`${model.author.name} (${model.author.handle})`)}`);
    if (model.iso) out.push(`date: ${model.iso}`);
    if (model.url) out.push(`source: ${model.url}`);
    out.push('---', '');
  }
  if (navigation) out.push(navigation, '');
  out.push(`${'#'.repeat(headingLevel)} ${escapeMd(model.title)}`, '');
  const by = model.author.url ? `[${escapeMd(model.author.name || model.author.handle)}](${mdUrl(model.author.url)})` : escapeMd(model.author.name);
  const src = model.url ? ` · [Original thread](${mdUrl(model.url)})` : '';
  out.push(`By ${by} ${escapeMd(model.author.handle)} · ${model.date}${src}`, '');

  const displayed = joinContinuations ? joinContinuationPosts(model.posts) : model.posts;
  for (const p of displayed) {
    if (emojiImages || joinContinuations) {
      for (const source of p.sourcePosts || [p]) out.push(`<a id="s-${escHtml(source.id)}"></a>`, '');
    }
    out.push(mdPostBody(p, { emojiImages, headingOffset: headingLevel + 1 }), '');
    if (!joinContinuations) out.push(mdMeta(p, { showAuthor: p.author.handle !== model.author.handle }), '');
  }
  if (joinContinuations) {
    out.push(`<details>\n<summary>Source posts (${model.posts.length})</summary>`, '');
    for (const p of model.posts) out.push(mdMeta(p, { showAuthor: p.author.handle !== model.author.handle }), '');
    out.push('</details>', '');
  }

  if (model.replies.length) {
    out.push(`${'#'.repeat(headingLevel + 1)} Replies`, '');
    for (const r of model.replies) {
      if (emojiImages) out.push(`<a id="s-${escHtml(r.id)}"></a>`, '');
      out.push(mdMeta(r, { showAuthor: true, replyTo: r.replyTo }), '');
      out.push(mdPostBody(r, { emojiImages, headingOffset: headingLevel + 1 }), '');
    }
  }

  const count = model.posts.length + model.replies.length;
  const foot = [`Exported from ${model.host}${model.via ? ` via ${model.via}` : ''}`, `${count} post${count === 1 ? '' : 's'}`];
  if (!model.includeForks) foot.push('replies from others left out');
  out.push('---', '', `*${[...foot, ...model.notes].join('. ')}.*`, '', `<sub>[Powered by fedithread](${PROJECT_URL})</sub>`, '');
  return out.join('\n');
}

// ------------------------------------------------------------------------ HTML

const CSS = `
:root { color-scheme: light dark; --fg: #1c1c1e; --muted: #6b6b70; --line: #d9d9de; --bg: #fff; --soft: #f2f2f4; --accent: #563acc; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ec; --muted: #9a9aa5; --line: #363845; --bg: #191b22; --soft: #23252f; --accent: #9d8cff; } }
body { margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg); font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
article { max-width: 42rem; margin: 0 auto; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; }
img.emoji { height: 1.2em; width: auto; vertical-align: -0.25em; }
h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .5rem; }
h2 { font-size: 1.3rem; margin: 2.5rem 0 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.byline, .meta, footer { color: var(--muted); font-size: .9rem; }
.byline { margin: 0 0 2rem; }
.post { margin: 0 0 1.5rem; }
.content p { margin: 0 0 .8em; }
.meta { margin: .3rem 0 0; }
.meta a { color: inherit; text-decoration: none; }
.meta a:hover { text-decoration: underline; }
.cw { font-weight: 600; margin: 0 0 .5em; }
pre { overflow-x: auto; background: var(--soft); padding: .6rem .8rem; border-radius: 6px; font-size: .9em; }
code { background: var(--soft); padding: .1em .3em; border-radius: 4px; font-size: .92em; }
pre code { background: none; padding: 0; }
blockquote { margin: .8em 0; padding-left: .8em; border-left: 3px solid var(--line); color: var(--muted); }
.media { display: grid; gap: .5rem; margin: .8em 0; }
.media img { display: block; border-radius: 6px; }
.poll { list-style: none; padding: 0; margin: .6em 0; }
.poll li { position: relative; padding: .3rem .5rem; margin-bottom: .3rem; border-radius: 6px; background: var(--soft); overflow: hidden; }
.poll .bar { position: absolute; inset: 0 auto 0 0; background: var(--line); opacity: .5; }
.poll span { position: relative; }
.reply { margin: 0 0 1.2rem calc(var(--depth) * 1.2rem); padding-left: .8rem; border-left: 2px solid var(--line); }
.reply > .meta { margin: 0 0 .5rem; }
.reply .who { font-weight: 600; color: var(--fg); }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
footer .powered { display: block; margin-top: .35rem; font-size: .85em; }
footer .powered a { color: inherit; }
`.trim();

function htmlMedia(m) {
  if (!m.url) return m.unavailable ? `<p>${escHtml(m.unavailable)}</p>` : '';
  if (m.type === 'image' && !m.sensitive && !m.linked) return `<a href="${escHtml(m.url)}"><img src="${escHtml(m.url)}" alt="${escHtml(m.alt)}" loading="lazy"></a>`;
  const kind = m.linked ? `${m.sensitive ? 'Sensitive image' : 'Image'} not bundled` : m.sensitive ? `Sensitive ${m.type}` : m.type[0].toUpperCase() + m.type.slice(1);
  return `<p><a href="${escHtml(m.url)}">${escHtml(kind)}${m.alt ? `: ${escHtml(m.alt)}` : ''}</a></p>`;
}

function htmlPoll(poll) {
  if (!poll) return '';
  const items = poll.options.map((o) => `<li><span class="bar" style="width:${o.pct}%"></span><span>${escHtml(o.title)} <small>${o.pct}% (${o.votes})</small></span></li>`);
  return `<ul class="poll">${items.join('')}</ul><p class="meta">${poll.total} vote${poll.total === 1 ? '' : 's'}${poll.expired ? ', closed' : ''}</p>`;
}

function htmlPostBody(p) {
  let s = '';
  if (p.cw) s += `<p class="cw">CW: ${escHtml(p.cw)}</p>`;
  s += `<div class="content">${cleanHtml(p.html)}</div>`;
  const media = p.media.map(htmlMedia).filter(Boolean);
  if (media.length) s += `<div class="media">${media.join('')}</div>`;
  s += htmlPoll(p.poll);
  return s;
}

const htmlWho = (p) => {
  const name = escHtml(p.author.name || p.author.handle);
  const link = p.author.url ? `<a class="who" href="${escHtml(p.author.url)}">${name}</a>` : `<span class="who">${name}</span>`;
  return `${link} ${escHtml(p.author.handle)}`;
};

function htmlMeta(p, { showAuthor, replyTo }) {
  const bits = [];
  if (showAuthor) bits.push(htmlWho(p));
  const time = `<time datetime="${escHtml(p.iso || '')}">${escHtml(p.date)}</time>`;
  bits.push(p.url ? `<a href="${escHtml(p.url)}">${time}</a>` : time);
  if (replyTo?.missing) bits.push(`replying to ${escHtml(replyTo.name)} that could not be fetched`);
  else if (replyTo) bits.push(`replying to <a href="#s-${escHtml(replyTo.id)}">${escHtml(replyTo.name)}</a>`);
  if (p.visibility) bits.push(escHtml(p.visibility));
  if (p.edited) bits.push('edited');
  return `<p class="meta">${bits.join(' · ')}</p>`;
}

export function toHtml(model, { fragment = false, headingLevel = 1, styleHref = '', navigation = '', collapseReplies = false, joinContinuations = false } = {}) {
  const out = [];
  if (!fragment) {
    out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">');
    out.push(`<title>${escHtml(model.title)}</title>`);
    if (model.url) out.push(`<link rel="canonical" href="${escHtml(model.url)}">`);
    out.push(styleHref ? `<link rel="stylesheet" href="${escHtml(styleHref)}">` : `<style>${CSS}</style>`, '</head>', '<body>', '<article>');
  }
  if (navigation) out.push(navigation);
  out.push('<header>', `<h${headingLevel}>${escHtml(model.title)}</h${headingLevel}>`);
  const by = model.author.url ? `<a href="${escHtml(model.author.url)}">${escHtml(model.author.name || model.author.handle)}</a>` : escHtml(model.author.name);
  const src = model.url ? ` · <a href="${escHtml(model.url)}">Original thread</a>` : '';
  out.push(`<p class="byline">By ${by} ${escHtml(model.author.handle)} · <time datetime="${escHtml(model.iso || '')}">${escHtml(model.date)}</time>${src}</p>`, '</header>');

  const displayed = joinContinuations ? joinContinuationPosts(model.posts) : model.posts;
  for (const p of displayed) {
    out.push(`<section class="post" id="s-${escHtml(p.id)}">`);
    if (joinContinuations) {
      for (const source of p.sourcePosts.slice(1)) out.push(`<span id="s-${escHtml(source.id)}"></span>`);
    }
    out.push(htmlPostBody(p));
    if (!joinContinuations) out.push(htmlMeta(p, { showAuthor: p.author.handle !== model.author.handle }));
    out.push('</section>');
  }
  if (joinContinuations) {
    out.push(`<details class="source-posts"><summary>Source posts (${model.posts.length})</summary>`);
    for (const p of model.posts) out.push(htmlMeta(p, { showAuthor: p.author.handle !== model.author.handle }));
    out.push('</details>');
  }

  if (model.replies.length) {
    out.push(collapseReplies ? '<details class="replies"><summary>Discussion</summary>' : '<section class="replies">');
    if (!collapseReplies) out.push(`<h${headingLevel + 1}>Replies</h${headingLevel + 1}>`);
    for (const r of model.replies) {
      out.push(`<div class="reply" id="s-${escHtml(r.id)}" style="--depth:${Math.min(r.depth, 6)}">`);
      out.push(htmlMeta(r, { showAuthor: true, replyTo: r.replyTo }));
      out.push(htmlPostBody(r));
      out.push('</div>');
    }
    out.push(collapseReplies ? '</details>' : '</section>');
  }

  const count = model.posts.length + model.replies.length;
  const foot = [`Exported from ${escHtml(model.host)}${model.via ? ` via ${escHtml(model.via)}` : ''}`, `${count} post${count === 1 ? '' : 's'}`];
  if (!model.includeForks) foot.push('replies from others left out');
  out.push(`<footer>${[...foot, ...model.notes.map(escHtml)].join('. ')}.<small class="powered"><a href="${PROJECT_URL}">Powered by fedithread</a></small></footer>`);
  if (!fragment) out.push('</article>', '</body>', '</html>', '');
  return out.join('\n');
}

export function archiveId(id) {
  return /^[a-z0-9_-]+$/i.test(id) ? id : `~${[...new TextEncoder().encode(id)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function buildSeriesExport(snapshot, { content, joinContinuations = false }) {
  const articles = snapshot.articles.map((article) => {
    const model = buildExport(article.tree, article.main, {
      rootId: article.id, host: snapshot.target.host, content,
      includeForks: snapshot.includeDiscussion, missing: article.missing,
    });
    for (const p of [...model.posts, ...model.replies]) {
      p.url = safeHttpUrl(p.url);
      p.uri = safeHttpUrl(p.uri);
      p.author.url = safeHttpUrl(p.author.url);
      if (p.replyTo) p.replyTo.url = safeHttpUrl(p.replyTo.url);
      for (const m of p.media) {
        m.url = safeHttpUrl(m.url);
        if (!m.url) m.unavailable = `This ${m.type} has no usable source URL and was not bundled.`;
      }
    }
    model.author.url = safeHttpUrl(model.author.url);
    model.url = safeHttpUrl(model.url);
    return { ...model, id: article.id, file: archiveId(article.id), notes: [...new Set([...model.notes, ...article.notes])] };
  });
  return {
    title: snapshot.title, source: snapshot.source, author: snapshot.account?.acct || snapshot.target.acct,
    tag: snapshot.target.tag, fetchedAt: snapshot.fetchedAt, includeDiscussion: snapshot.includeDiscussion,
    warnings: snapshot.warnings, complete: snapshot.complete, articles, joinContinuations,
  };
}

function mapDocument(model, article, assets, { format, combined = false }) {
  const base = combined ? '' : '../';
  const prefix = combined ? `${article.file}-` : '';
  const links = new Map();
  for (const kind of ['posts', 'replies']) for (const entry of model.articles) {
    for (const p of entry[kind]) {
      const fragment = `#s-${combined ? `${entry.file}-` : ''}${archiveId(p.id)}`;
      for (const url of [p.url, p.uri]) {
        if (url && !links.has(url)) links.set(url, combined ? fragment : `${base}posts/${entry.file}.${format}${fragment}`);
      }
    }
  }
  const rewrite = (html) => {
    const visit = (nodes) => nodes.map((n) => {
      if (n.text != null) return n;
      const copy = { ...n, attrs: { ...n.attrs }, children: visit(n.children) };
      if (copy.tag === 'a' && links.has(copy.attrs.href)) copy.attrs.href = links.get(copy.attrs.href);
      if (copy.tag === 'img') {
        const asset = assets.get(copy.attrs.src);
        if (asset) copy.attrs.src = base + asset.path;
        else return { tag: 'a', attrs: { href: safeHttpUrl(copy.attrs.src) }, children: [{ text: `[Image not bundled: ${copy.attrs.alt || 'image'}]` }] };
      }
      if (format === 'html' && /^h[1-6]$/.test(copy.tag)) copy.tag = `h${Math.min(6, Number(copy.tag[1]) + (combined ? 3 : 2))}`;
      return copy;
    });
    return htmlNodes(visit(parseHtml(html)));
  };
  const post = (p) => ({
    ...p, id: prefix + archiveId(p.id), html: rewrite(p.html),
    parentId: p.parentId ? prefix + archiveId(p.parentId) : null,
    replyTo: p.replyTo ? { ...p.replyTo, id: prefix + archiveId(p.replyTo.id) } : undefined,
    media: p.media.map((m) => {
      if (m.type !== 'image') return m;
      const asset = assets.get(m.url);
      return asset ? { ...m, url: base + asset.path } : { ...m, linked: true };
    }),
  });
  return { ...article, posts: article.posts.map(post), replies: article.replies.map(post) };
}

export function seriesDocuments(model, { format, assets = new Map(), omissions = [], exportedAt = new Date().toISOString() }) {
  if (!['html', 'md'].includes(format)) throw new Error('Unsupported archive format.');
  const files = new Map();
  const warnings = [...new Set([...model.warnings, ...omissions.map((o) => `${o.url}: ${o.reason}`)])];
  const partial = !model.complete || warnings.length > 0;
  const label = partial ? 'Partial archive' : 'Collection snapshot';
  const noticeMd = `> **${label}.** Public API-visible posts only.${warnings.length ? '\n>\n' + warnings.map((w) => `> - ${escapeMd(w.replace(/\r?\n/g, ' '))}`).join('\n') : ''}`;
  const noticeHtml = `<aside><p><strong>${label}.</strong> Public API-visible posts only.</p>${warnings.length ? `<ul>${warnings.map((w) => `<li>${escHtml(w)}</li>`).join('')}</ul>` : ''}</aside>`;
  const indexName = format === 'html' ? 'index.html' : 'README.md';
  const allName = `all.${format}`;
  const listHtml = `<ol>${model.articles.map((a) => `<li><a href="posts/${a.file}.html">${escHtml(a.title)}</a></li>`).join('')}</ol>`;
  const listMd = model.articles.map((a) => `- [${escapeMd(a.title)}](posts/${a.file}.md)`).join('\n');
  const htmlPage = (body) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escHtml(model.title)}</title><link rel="stylesheet" href="assets/style.css"></head><body><article>${body}</article></body></html>\n`;
  const headerHtml = `<h1>${escHtml(model.title)}</h1><p><a href="${escHtml(model.source)}">Original tagged collection</a> · ${model.articles.length} articles · oldest first</p>${noticeHtml}`;
  const headerMd = `# ${escapeMd(model.title)}\n\n[Original tagged collection](${mdUrl(model.source)}) · ${model.articles.length} articles · oldest first\n\n${noticeMd}\n\n`;
  if (format === 'html') {
    files.set('assets/style.css', `${CSS}\nnav, aside { margin: 1rem 0; } aside { padding: .8rem; background: var(--soft); } summary { cursor: pointer; } .entry { margin-top: 3rem; }`);
    files.set(indexName, htmlPage(`${headerHtml}<p><a href="${allName}">Read all</a></p>${listHtml}`));
  } else files.set(indexName, `${headerMd}[Read all](${allName})\n\n${listMd}\n`);
  const combined = [];
  for (let i = 0; i < model.articles.length; i++) {
    const article = model.articles[i];
    const neighbors = [
      ['Index', `../${indexName}`], ['Read all', `../${allName}`],
      ...(i ? [['Previous', `${model.articles[i - 1].file}.${format}`]] : []),
      ...(i + 1 < model.articles.length ? [['Next', `${model.articles[i + 1].file}.${format}`]] : []),
    ];
    const navigation = format === 'html'
      ? `<nav>${neighbors.map(([name, href]) => `<a href="${href}">${name}</a>`).join(' · ')}</nav>${noticeHtml}`
      : neighbors.map(([name, href]) => `[${name}](${href})`).join(' · ') + `\n\n${noticeMd}`;
    const page = mapDocument(model, article, assets, { format });
    const all = mapDocument(model, article, assets, { format, combined: true });
    if (format === 'html') {
      files.set(`posts/${article.file}.html`, toHtml(page, { styleHref: '../assets/style.css', navigation, collapseReplies: true, joinContinuations: model.joinContinuations }));
      combined.push(`<section class="entry" id="entry-${article.file}">${toHtml(all, { fragment: true, headingLevel: 2, collapseReplies: true, joinContinuations: model.joinContinuations })}</section>`);
    } else {
      files.set(`posts/${article.file}.md`, toMarkdown(page, { emojiImages: true, navigation, joinContinuations: model.joinContinuations }));
      combined.push(`<a id="entry-${article.file}"></a>\n\n${toMarkdown(all, { frontMatter: false, headingLevel: 2, emojiImages: true, joinContinuations: model.joinContinuations })}`);
    }
  }
  const contentsHtml = `<ol>${model.articles.map((a) => `<li><a href="#entry-${a.file}">${escHtml(a.title)}</a></li>`).join('')}</ol>`;
  const contentsMd = model.articles.map((a) => `- [${escapeMd(a.title)}](#entry-${a.file})`).join('\n');
  files.set(allName, format === 'html'
    ? htmlPage(`<nav><a href="${indexName}">Index</a></nav>${headerHtml}${contentsHtml}${combined.join('\n')}`)
    : `${headerMd}[Index](${indexName})\n\n${contentsMd}\n\n${combined.join('\n')}`);
  files.set('manifest.json', JSON.stringify({
    formatVersion: 1, source: model.source, author: model.author, tag: model.tag, format,
    fetchedAt: model.fetchedAt, exportedAt, partial, includeDiscussion: model.includeDiscussion, joinContinuations: !!model.joinContinuations,
    warnings, omissions,
    articles: model.articles.map((a) => ({ id: a.id, file: `posts/${a.file}.${format}`, source: a.url, statuses: a.posts.map((p) => p.id), replies: a.replies.map((p) => p.id) })),
    assets: [...assets].map(([url, asset]) => ({ source: url, file: asset.path })),
  }, null, 2) + '\n');
  return files;
}
