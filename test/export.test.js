import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, classifyNodes } from '../js/thread.js';
import {
  parseHtml, decodeEntities, htmlToText, htmlToMarkdown, cleanHtml,
  buildExport, toMarkdown, toHtml, suggestedFileName, threadTitle,
} from '../js/export.js';

// --- parsing -------------------------------------------------------------

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &nbsp;&bogus;'), "a & b <c> 'd' \u00a0&bogus;");
});

test('parseHtml builds a tree, closes unbalanced tags, keeps void elements flat', () => {
  const nodes = parseHtml('<p>Hi <a href="https://x.example/?a=1&amp;b=2" class="mention">@x</a><br>there</p><p>two');
  assert.equal(nodes.length, 2);
  const [p1, p2] = nodes;
  assert.equal(p1.tag, 'p');
  assert.deepEqual(p1.children.map((n) => n.text ?? n.tag), ['Hi ', 'a', 'br', 'there']);
  assert.equal(p1.children[1].attrs.href, 'https://x.example/?a=1&b=2');
  assert.deepEqual(p2.children, [{ text: 'two' }]);
});

test('htmlToText drops invisible spans and completes ellipsised links', () => {
  const html = '<p>See <a href="https://example.com/a/very/long/path"><span class="invisible">https://</span><span class="ellipsis">example.com/a/very</span><span class="invisible">/long/path</span></a> now</p>';
  assert.equal(htmlToText(html), 'See example.com/a/very… now');
});

// --- HTML -> Markdown ----------------------------------------------------

test('htmlToMarkdown converts paragraphs, breaks, emphasis, links and mentions', () => {
  const html = '<p>Hello <strong>world</strong>, <em>soft</em> <s>gone</s><br>next line <a href="https://a.example/@bob" class="u-url mention">@<span>bob</span></a></p><p>Second.</p>';
  assert.equal(htmlToMarkdown(html), 'Hello **world**, *soft* ~~gone~~\\\nnext line [@bob](https://a.example/@bob)\n\nSecond.');
});

test('htmlToMarkdown escapes markdown and raw html in text', () => {
  assert.equal(htmlToMarkdown('<p>1 * 2 [x] &lt;script&gt; snake_case _emph_ ~~no~~</p>'), '1 \\* 2 \\[x\\] \\<script> snake_case \\_emph\\_ \\~\\~no\\~\\~');
  assert.equal(htmlToMarkdown('<p># not a heading<br>- not a list<br>1. nor this</p>'), '\\# not a heading\\\n\\- not a list\\\n\\1. nor this');
});

test('htmlToMarkdown handles code, pre, quotes, lists and headings', () => {
  const html = '<p>Run <code>a `b` c</code>:</p><pre><code>line *1*\nline 2\n</code></pre><blockquote><p>quoted</p><p>more</p></blockquote><ul><li>one</li><li>two<br>lines</li></ul><ol><li>first</li></ol><h1>Big</h1>';
  assert.equal(htmlToMarkdown(html), [
    'Run `` a `b` c ``:',
    '',
    '```',
    'line *1*',
    'line 2',
    '```',
    '',
    '> quoted',
    '>',
    '> more',
    '',
    '- one',
    '- two\\',
    '  lines',
    '',
    '1. first',
    '',
    '### Big',
  ].join('\n'));
});

test('htmlToMarkdown renders custom emoji as shortcodes and images as images', () => {
  const html = '<p>hi <img class="emoji" src="https://x/e.png" alt=":wave:" title=":wave:" draggable="false"> <img src="https://x/p.png" alt="a [pic]"></p>';
  assert.equal(htmlToMarkdown(html), 'hi :wave: ![a \\[pic\\]](https://x/p.png)');
});

test('htmlToMarkdown encodes awkward characters in urls', () => {
  assert.equal(htmlToMarkdown('<p><a href="https://x/a (b)">t</a></p>'), '[t](https://x/a%20%28b%29)');
});

// --- HTML -> clean HTML --------------------------------------------------

test('cleanHtml keeps structure, drops classes, rel and target, and hidden link parts', () => {
  const html = '<p>Hi <a href="https://x/y" rel="nofollow noopener noreferrer" target="_blank" class="mention"><span class="invisible">https://</span><span class="ellipsis">x/y</span></a> <b>b</b> <i>i</i> <span class="h-card">c</span> &lt;s&gt;</p>';
  assert.equal(cleanHtml(html), '<p>Hi <a href="https://x/y">x/y…</a> <strong>b</strong> <em>i</em> c &lt;s&gt;</p>');
});

test('cleanHtml keeps emoji images and escapes attribute values', () => {
  const html = '<p><img class="emoji" src="https://x/e.png" alt=":a&quot;b:" title=":a&quot;b:"><img src="https://x/p.png" alt="q"></p>';
  assert.equal(cleanHtml(html), '<p><img class="emoji" src="https://x/e.png" alt=":a&quot;b:" title=":a&quot;b:"><img src="https://x/p.png" alt="q"></p>');
});

// --- model and documents -------------------------------------------------

let t = 0;
const st = (id, parent, acct, content, extra = {}) => ({
  id, in_reply_to_id: parent, content,
  account: { id: acct, acct, username: acct, display_name: acct.toUpperCase(), url: `https://h.example/@${acct}` },
  url: `https://h.example/@${acct}/${id}`,
  created_at: new Date(Date.UTC(2024, 0, 1, 12, t++)).toISOString(),
  ...extra,
});

// op: 1 -> 2 -> 3; bob forks off 2, carol replies to bob.
const fixture = () => {
  t = 0;
  return [
    st('1', null, 'op', '<p>Thread title here &amp; more <a href="https://h.example/tags/x" class="mention hashtag">#x</a></p><p>Body of the first post.</p>'),
    st('2', '1', 'op', '<p>Second post.</p>', {
      media_attachments: [{ type: 'image', url: 'https://h.example/m/1.png', description: 'a chart' }],
      poll: { voters_count: 4, expired: true, options: [{ title: 'Yes', votes_count: 3 }, { title: 'No', votes_count: 1 }] },
    }),
    st('4', '2', 'bob', '<p>Fork from bob.</p>', { spoiler_text: 'spoilers', edited_at: '2024-01-02T00:00:00.000Z' }),
    st('7', '4', 'carol', '<p>Reply to bob.</p>', { visibility: 'unlisted' }),
    st('3', '2', 'op', '<p>Third post.</p>'),
  ];
};

const model = (includeForks = true) => {
  const tree = buildTree(fixture());
  const main = classifyNodes(tree, '1', '1');
  return buildExport(tree, main, { rootId: '1', host: 'h.example', includeForks, content: (s) => s.content, missing: 2 });
};

test('buildExport orders the main line and flattens forks with depth and replyTo', () => {
  const m = model();
  assert.equal(m.title, 'Thread title here & more #x');
  assert.deepEqual(m.posts.map((p) => p.id), ['1', '2', '3']);
  assert.deepEqual(m.replies.map((r) => [r.id, r.depth, r.replyTo.id]), [['4', 0, '2'], ['7', 1, '4']]);
  assert.equal(m.author.handle, '@op@h.example');
  assert.equal(m.date, '2024-01-01 12:00 UTC');
  assert.deepEqual(m.posts[1].poll.options.map((o) => o.pct), [75, 25]);
  assert.deepEqual(m.notes, ['about 2 more replies were not reachable anonymously']);
  assert.equal(model(false).replies.length, 0);
});

test('threadTitle prefers the content warning, truncates long text, falls back to the handle', () => {
  assert.equal(threadTitle({ content: '<p>x</p>', spoiler_text: 'CW text', account: { acct: 'a' } }, 'h'), 'CW text');
  const long = '<p>' + 'word '.repeat(30) + '</p>';
  const title = threadTitle({ content: long, account: { acct: 'a' } }, 'h');
  assert.ok(title.length <= 81 && title.endsWith('…'), title);
  assert.equal(threadTitle({ content: '', account: { acct: 'a' } }, 'h'), 'Thread by @a@h');
});

test('suggestedFileName slugifies the title', () => {
  assert.equal(suggestedFileName(model(), 'md'), 'thread-title-here-more-x.md');
  assert.equal(suggestedFileName({ title: '???', posts: [{ id: '9' }] }, 'html'), 'thread-9.html');
});

test('toMarkdown produces front matter, article, replies and footer', () => {
  const md = toMarkdown(model());
  assert.equal(md, `---
title: "Thread title here & more #x"
author: "OP (@op@h.example)"
date: 2024-01-01T12:00:00.000Z
source: https://h.example/@op/1
---

# Thread title here & more #x

By [OP](https://h.example/@op) @op@h.example · 2024-01-01 12:00 UTC · [Original thread](https://h.example/@op/1)

Thread title here & more [#x](https://h.example/tags/x)

Body of the first post.

<sub>[2024-01-01 12:00 UTC](https://h.example/@op/1)</sub>

Second post.

![a chart](https://h.example/m/1.png)

- Yes — 75% (3)
- No — 25% (1)

*4 votes, closed*

<sub>[2024-01-01 12:01 UTC](https://h.example/@op/2)</sub>

Third post.

<sub>[2024-01-01 12:04 UTC](https://h.example/@op/3)</sub>

## Replies

<sub>**BOB** @bob@h.example · [2024-01-01 12:02 UTC](https://h.example/@bob/4) · replying to [OP](https://h.example/@op/2) · edited</sub>

**CW: spoilers**

Fork from bob.

<sub>**CAROL** @carol@h.example · [2024-01-01 12:03 UTC](https://h.example/@carol/7) · replying to [BOB](https://h.example/@bob/4) · unlisted</sub>

Reply to bob.

---

*Exported from h.example with fedithread. 5 posts. about 2 more replies were not reachable anonymously.*
`);
});

test('toMarkdown without forks says so', () => {
  const md = toMarkdown(model(false));
  assert.ok(!md.includes('## Replies'));
  assert.ok(md.includes('3 posts. replies from others left out.'));
});

test('toHtml is a standalone page with anchors, nesting and no scripts', () => {
  const html = toHtml(model());
  assert.ok(html.startsWith('<!doctype html>\n<html lang="en">'));
  assert.ok(html.includes('<title>Thread title here &amp; more #x</title>'));
  assert.ok(html.includes('<link rel="canonical" href="https://h.example/@op/1">'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('<section class="post" id="s-1">'));
  assert.ok(html.includes('<div class="content"><p>Thread title here &amp; more <a href="https://h.example/tags/x">#x</a></p><p>Body of the first post.</p></div>'));
  assert.ok(html.includes('<a href="https://h.example/m/1.png"><img src="https://h.example/m/1.png" alt="a chart" loading="lazy"></a>'));
  assert.ok(html.includes('<li><span class="bar" style="width:75%"></span><span>Yes <small>75% (3)</small></span></li>'));
  assert.ok(html.includes('<div class="reply" id="s-4" style="--depth:0">'));
  assert.ok(html.includes('<div class="reply" id="s-7" style="--depth:1">'));
  assert.ok(html.includes('replying to <a href="#s-4">BOB</a>'));
  assert.ok(html.includes('<p class="cw">CW: spoilers</p>'));
  assert.ok(html.includes('<footer>Exported from h.example with fedithread. 5 posts. about 2 more replies were not reachable anonymously.</footer>'));
  // Main-line posts by the root author carry no author line; others do.
  assert.ok(!html.includes('<a class="who" href="https://h.example/@op">'));
  assert.ok(html.includes('<a class="who" href="https://h.example/@bob">BOB</a> @bob@h.example'));
});

test('sensitive media exports as a link rather than an inline image', () => {
  const tree = buildTree([st('1', null, 'op', '<p>x</p>', { sensitive: true, media_attachments: [{ type: 'image', url: 'https://h.example/m/s.png', description: 'eek' }] })]);
  const m = buildExport(tree, classifyNodes(tree, '1', '1'), { rootId: '1', host: 'h.example', content: (s) => s.content });
  assert.ok(toMarkdown(m).includes('[Sensitive image: eek](https://h.example/m/s.png)'));
  assert.ok(toHtml(m).includes('<p><a href="https://h.example/m/s.png">Sensitive image: eek</a></p>'));
  assert.ok(!toHtml(m).includes('<img src="https://h.example/m/s.png"'));
});

test('known custom emoji shortcodes are stripped from titles and names', () => {
  const emojis = [{ shortcode: 'cat', url: 'https://x/c.png' }];
  const root = { id: '1', content: '<p>Hello :cat: world :unknown:</p>', account: { acct: 'a', display_name: 'A :cat:', emojis }, emojis, url: 'https://x/1' };
  const tree = buildTree([root]);
  const m = buildExport(tree, classifyNodes(tree, '1', '1'), { rootId: '1', host: 'h', content: (s) => s.content });
  assert.equal(m.title, 'Hello world :unknown:');
  assert.equal(m.author.name, 'A');
});
