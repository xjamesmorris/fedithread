// Export a collected thread as a standalone HTML page or a Markdown document,
// laid out like a blog entry: the main line is the article, forks are the
// replies section. Pure: no DOM, no network. Status content arrives as
// already-sanitised HTML strings (see statusContentHtml in sanitize.js) and is
// re-parsed here with a small tokenizer that only has to cope with the
// well-formed, allowlisted markup our sanitiser emits.

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
      const level = Math.min(6, Number(n.tag[1]) + 2);
      return `\n\n${'#'.repeat(level)} ${inner().trim()}\n\n`;
    }
    case 'img': return isEmoji(n) ? (n.attrs.alt || '') : `![${escapeMd(n.attrs.alt || '')}](${mdUrl(n.attrs.src)})`;
    default: return inner();
  }
}

export function htmlToMarkdown(html) {
  return mdNodes(parseHtml(html)).replace(/\n{3,}/g, '\n\n').trim();
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
    url: status.url || status.uri || '',
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
export function buildExport(tree, main, { rootId, host, includeForks = true, content, missing = 0, orphans = 0 }) {
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

  const rootPost = posts[0];
  const notes = [];
  if (missing) notes.push(`about ${missing} more ${missing === 1 ? 'reply was' : 'replies were'} not reachable anonymously`);
  if (orphans) notes.push(`${orphans} ${orphans === 1 ? 'reply' : 'replies'} could not be placed`);
  return {
    title: threadTitle(root, host),
    author: rootPost.author,
    date: rootPost.date,
    iso: rootPost.iso,
    url: rootPost.url,
    host,
    posts,
    replies,
    includeForks,
    notes,
  };
}

export function suggestedFileName(model, ext) {
  const slug = model.title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return `${slug || `thread-${model.posts[0]?.id || 'export'}`}.${ext}`;
}

// -------------------------------------------------------------------- Markdown

function mdMedia(m) {
  if (!m.url) return '';
  const label = m.alt || m.type;
  if (m.type === 'image' && !m.sensitive) return `![${escapeMd(m.alt)}](${mdUrl(m.url)})`;
  const kind = m.sensitive ? `Sensitive ${m.type}` : m.type[0].toUpperCase() + m.type.slice(1);
  return `[${kind}${m.alt ? `: ${escapeMd(label)}` : ''}](${mdUrl(m.url)})`;
}

function mdPoll(poll) {
  if (!poll) return '';
  const lines = poll.options.map((o) => `- ${escapeMd(o.title)} — ${o.pct}% (${o.votes})`);
  lines.push(`\n*${poll.total} vote${poll.total === 1 ? '' : 's'}${poll.expired ? ', closed' : ''}*`);
  return lines.join('\n');
}

function mdPostBody(p) {
  const parts = [];
  if (p.cw) parts.push(`**CW: ${escapeMd(p.cw)}**`);
  const body = htmlToMarkdown(p.html);
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
  if (replyTo) bits.push(replyTo.url ? `replying to [${escapeMd(replyTo.name)}](${mdUrl(replyTo.url)})` : `replying to ${escapeMd(replyTo.name)}`);
  if (p.visibility) bits.push(p.visibility);
  if (p.edited) bits.push('edited');
  return `<sub>${bits.join(' · ')}</sub>`;
}

export function toMarkdown(model) {
  const out = [];
  out.push('---');
  out.push(`title: ${JSON.stringify(model.title)}`);
  out.push(`author: ${JSON.stringify(`${model.author.name} (${model.author.handle})`)}`);
  if (model.iso) out.push(`date: ${model.iso}`);
  if (model.url) out.push(`source: ${model.url}`);
  out.push('---', '');
  out.push(`# ${escapeMd(model.title)}`, '');
  const by = model.author.url ? `[${escapeMd(model.author.name || model.author.handle)}](${mdUrl(model.author.url)})` : escapeMd(model.author.name);
  const src = model.url ? ` · [Original thread](${mdUrl(model.url)})` : '';
  out.push(`By ${by} ${escapeMd(model.author.handle)} · ${model.date}${src}`, '');

  for (const p of model.posts) {
    out.push(mdPostBody(p), '');
    out.push(mdMeta(p, { showAuthor: p.author.handle !== model.author.handle }), '');
  }

  if (model.replies.length) {
    out.push('## Replies', '');
    for (const r of model.replies) {
      out.push(mdMeta(r, { showAuthor: true, replyTo: r.replyTo }), '');
      out.push(mdPostBody(r), '');
    }
  }

  const count = model.posts.length + model.replies.length;
  const foot = [`Exported from ${model.host} with fedithread`, `${count} post${count === 1 ? '' : 's'}`];
  if (!model.includeForks) foot.push('replies from others left out');
  out.push('---', '', `*${[...foot, ...model.notes].join('. ')}.*`, '');
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
`.trim();

function htmlMedia(m) {
  if (!m.url) return '';
  if (m.type === 'image' && !m.sensitive) return `<a href="${escHtml(m.url)}"><img src="${escHtml(m.url)}" alt="${escHtml(m.alt)}" loading="lazy"></a>`;
  const kind = m.sensitive ? `Sensitive ${m.type}` : m.type[0].toUpperCase() + m.type.slice(1);
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
  if (replyTo) bits.push(`replying to <a href="#s-${escHtml(replyTo.id)}">${escHtml(replyTo.name)}</a>`);
  if (p.visibility) bits.push(escHtml(p.visibility));
  if (p.edited) bits.push('edited');
  return `<p class="meta">${bits.join(' · ')}</p>`;
}

export function toHtml(model) {
  const out = [];
  out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>${escHtml(model.title)}</title>`);
  if (model.url) out.push(`<link rel="canonical" href="${escHtml(model.url)}">`);
  out.push(`<style>${CSS}</style>`, '</head>', '<body>', '<article>');
  out.push('<header>', `<h1>${escHtml(model.title)}</h1>`);
  const by = model.author.url ? `<a href="${escHtml(model.author.url)}">${escHtml(model.author.name || model.author.handle)}</a>` : escHtml(model.author.name);
  const src = model.url ? ` · <a href="${escHtml(model.url)}">Original thread</a>` : '';
  out.push(`<p class="byline">By ${by} ${escHtml(model.author.handle)} · <time datetime="${escHtml(model.iso || '')}">${escHtml(model.date)}</time>${src}</p>`, '</header>');

  for (const p of model.posts) {
    out.push(`<section class="post" id="s-${escHtml(p.id)}">`);
    out.push(htmlPostBody(p));
    out.push(htmlMeta(p, { showAuthor: p.author.handle !== model.author.handle }));
    out.push('</section>');
  }

  if (model.replies.length) {
    out.push('<section class="replies">', '<h2>Replies</h2>');
    for (const r of model.replies) {
      out.push(`<div class="reply" id="s-${escHtml(r.id)}" style="--depth:${Math.min(r.depth, 6)}">`);
      out.push(htmlMeta(r, { showAuthor: true, replyTo: r.replyTo }));
      out.push(htmlPostBody(r));
      out.push('</div>');
    }
    out.push('</section>');
  }

  const count = model.posts.length + model.replies.length;
  const foot = [`Exported from ${escHtml(model.host)} with fedithread`, `${count} post${count === 1 ? '' : 's'}`];
  if (!model.includeForks) foot.push('replies from others left out');
  out.push(`<footer>${[...foot, ...model.notes.map(escHtml)].join('. ')}.</footer>`);
  out.push('</article>', '</body>', '</html>', '');
  return out.join('\n');
}
