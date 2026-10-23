import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSeries, seriesSnapshot } from '../js/series.js';
import { buildSeriesExport, seriesDocuments, archiveId } from '../js/export.js';
import { prepareArchive, imageSources } from '../js/archive.js';

const picture = 'https://media.example/picture.png';
const emoji = 'https://media.example/emoji.png';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64'));
const account = { id: 'author', acct: 'author', username: 'author', display_name: 'A & B', url: 'https://example.test/@author' };
const target = { host: 'example.test', acct: 'author', tag: 'works' };

function model({ sensitive = false, complete = true } = {}) {
  const state = createSeries(target);
  state.account = account;
  state.stage = complete ? 'ready' : 'author';
  state.fetchedAt = '2024-01-01T00:00:00.000Z';
  for (const [index, id] of ['100000000000000001', '100000000000000002'].entries()) {
    const post = {
      id, account, created_at: `2024-01-0${index + 1}T00:00:00.000Z`, in_reply_to_id: null,
      url: `https://example.test/@author/${id}`, visibility: 'public', sensitive,
      uri: `https://example.test/users/author/statuses/${id}`,
      content: `<p>Post ${index + 1}: <img class="emoji" src="${emoji}" alt=":wave:"></p><p><a href="https://example.test/@author/100000000000000002">Second article</a> <a href="https://example.test/users/author/statuses/100000000000000002">URI source</a></p>`,
      media_attachments: [
        { type: 'image', url: picture, description: 'A chart & its legend' },
        { type: 'video', url: 'https://media.example/video.mp4', description: 'Video' },
      ],
      tags: [{ name: 'works' }],
    };
    state.statuses.set(id, post);
    state.seeds.add(id);
  }
  return buildSeriesExport(seriesSnapshot(state), { content: (s) => s.content });
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockImages({ fail = '', bytes = png, type = 'image/png' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    if (url === fail) return new Response('', { status: 404 });
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(bytes.subarray(0, 12));
      c.enqueue(bytes.subarray(12));
      c.close();
    } }), { headers: { 'content-type': type } });
  };
  return calls;
}

function checkLinks(files, format) {
  for (const [path, value] of files) {
    if (!path.endsWith(`.${format}`)) continue;
    const refs = format === 'html'
      ? [...value.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
      : [...value.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    for (const ref of refs) {
      const url = new URL(ref.replace(/&amp;/g, '&'), `https://archive.test/${path}`);
      if (url.host !== 'archive.test') continue;
      const destination = decodeURIComponent(url.pathname.slice(1));
      assert.ok(files.has(destination), `${path}: ${ref} exists`);
      if (url.hash) {
        const anchor = decodeURIComponent(url.hash.slice(1));
        assert.ok(String(files.get(destination)).includes(`id="${anchor}"`), `${path}: ${ref} has an anchor`);
      }
    }
  }
}

test('archives bundle deduplicated images and emoji with complete relative navigation in both formats', async () => {
  const calls = mockImages();
  const source = model();
  assert.deepEqual(imageSources(source), [emoji, picture]);
  const cache = new Map();
  for (const format of ['html', 'md']) {
    const result = await prepareArchive(source, { format, cache });
    assert.equal(result.partial, false);
    assert.equal(result.omissions.length, 0);
    const manifest = JSON.parse(result.files.get('manifest.json'));
    assert.equal(manifest.assets.length, 2);
    assert.equal(manifest.articles.length, 2);
    assert.equal(manifest.partial, false);
    assert.equal(manifest.includeDiscussion, false);
    assert.ok(result.files.has(format === 'html' ? 'index.html' : 'README.md'));
    checkLinks(result.files, format);
    for (const [path, content] of result.files) {
      if (!path.endsWith(`.${format}`)) continue;
      assert.doesNotMatch(content, /<script\b/i);
      assert.doesNotMatch(content, /(?:src="|!\[[^\]]*\]\()https?:\/\/media\.example/);
    }
    const article = result.files.get(`posts/100000000000000001.${format}`);
    if (format === 'md') assert.match(article, /!\[:wave:\]\(\.\.\/assets\/[0-9a-f]+\.png\)/);
    else assert.match(article, /<details|<section class="post"/);
    assert.ok(article.includes('https://media.example/video.mp4'), 'video stays an external link');
    assert.ok(article.includes('https://example.test/@author/100000000000000001'), 'source attribution remains original');
  }
  assert.equal(calls.length, 2, 'the second format reuses the downloaded image bytes');
});

test('missing images and incomplete source content produce labeled partial files, not remote inline images', async () => {
  mockImages({ fail: picture });
  const result = await prepareArchive(model({ complete: false }), { format: 'html' });
  assert.equal(result.partial, true);
  assert.match(result.name, /-partial-html\.zip$/);
  assert.equal(result.omissions[0].url, picture);
  assert.match(result.files.get('index.html'), /Partial archive/);
  const article = result.files.get('posts/100000000000000001.html');
  assert.match(article, /Image not bundled/);
  assert.ok(article.includes(`href="${picture}"`));
  assert.ok(!article.includes(`src="${picture}"`));
  const manifest = JSON.parse(result.files.get('manifest.json'));
  assert.equal(manifest.partial, true);
  assert.match(manifest.warnings.join(' '), /not finished/);
});

test('per-image and aggregate limits are enforced on streamed bytes, including exact boundaries', async () => {
  mockImages();
  const size = png.length;
  const exact = await prepareArchive(model(), { format: 'md', limits: { perImage: size, total: size * 2 } });
  assert.equal(exact.partial, false);
  const oversized = await prepareArchive(model(), { format: 'md', limits: { perImage: size - 1, total: size * 2 } });
  assert.equal(oversized.omissions.length, 2);
  assert.match(oversized.omissions[0].reason, /size limit/);
  const total = await prepareArchive(model(), { format: 'md', limits: { perImage: size, total: size * 2 - 1 } });
  assert.equal(total.omissions.length, 1);
  const manifest = JSON.parse(total.files.get('manifest.json'));
  assert.equal(manifest.assets.length, 1);
});

test('SVG, HTML, and a misleading raster content type cannot become active archive assets', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'image/png']) {
    mockImages({ type, bytes: new TextEncoder().encode('<svg onload="alert(1)"></svg>') });
    const result = await prepareArchive(model(), { format: 'html' });
    assert.equal(result.omissions.length, 2);
    assert.equal(JSON.parse(result.files.get('manifest.json')).assets.length, 0);
    assert.doesNotMatch(result.files.get('all.html'), /onload|<svg/i);
  }
});

test('sensitive images stay labeled links even when bundled locally', async () => {
  mockImages();
  const result = await prepareArchive(model({ sensitive: true }), { format: 'html' });
  const article = result.files.get('posts/100000000000000001.html');
  assert.match(article, /Sensitive image: A chart &amp; its legend/);
  const manifest = JSON.parse(result.files.get('manifest.json'));
  const asset = manifest.assets.find((a) => a.source === picture);
  assert.ok(article.includes(`href="../${asset.file}"`));
  assert.ok(!article.includes(`src="../${asset.file}"`));
});

test('aborted downloads are not converted into partial-export successes', async () => {
  const ctrl = new AbortController();
  globalThis.fetch = async () => {
    ctrl.abort();
    throw ctrl.signal.reason;
  };
  await assert.rejects(prepareArchive(model(), { format: 'md', signal: ctrl.signal }), { name: 'AbortError' });
});

test('rate-limited media stops further uncached image requests and reports every omission', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 429 }); };
  const result = await prepareArchive(model(), { format: 'html' });
  assert.equal(calls, 1);
  assert.equal(result.omissions.length, 2);
  assert.match(result.omissions[1].reason, /rate limit/);
  assert.equal(result.partial, true);
});

test('attachments without usable URLs remain explicit gaps, not silently missing content', async () => {
  mockImages();
  const source = model();
  source.articles[0].posts[0].media.push({ type: 'image', url: '', alt: 'missing', unavailable: 'This image has no usable source URL and was not bundled.' });
  const result = await prepareArchive(source, { format: 'md' });
  assert.equal(result.partial, true);
  assert.match(result.omissions[0].reason, /no usable source URL/);
  assert.match(result.files.get('posts/100000000000000001.md'), /no usable source URL/);
});

test('generated names cannot traverse directories or collide with escaped IDs', () => {
  assert.notEqual(archiveId('a/b'), archiveId('~612f62'));
  assert.doesNotMatch(archiveId('../outside'), /[/.]/);
  const source = model();
  source.articles[0].id = '../outside';
  source.articles[0].file = archiveId('../outside');
  const files = seriesDocuments(source, { format: 'md' });
  assert.ok([...files.keys()].every((path) => !path.includes('..')));
});

test('internal links prefer an article narrative over its copy in another discussion, including URI aliases', () => {
  const source = model();
  const [first, second] = source.articles;
  first.replies.push({ ...second.posts[0], depth: 0, replyTo: { id: first.id, name: 'Author', url: first.url } });
  const files = seriesDocuments(source, { format: 'html' });
  const article = files.get(`posts/${first.file}.html`);
  assert.ok(article.includes(`<a href="../posts/${second.file}.html#s-${second.id}">Second article</a>`));
  assert.ok(article.includes(`<a href="../posts/${second.file}.html#s-${second.id}">URI source</a>`));
  const all = files.get('all.html');
  assert.ok(all.includes(`<a href="#s-${second.file}-${second.id}">URI source</a>`));
});

test('joined-text archives preserve namespaced anchors and record the selected option', async () => {
  mockImages();
  const source = model();
  source.joinContinuations = true;
  const first = source.articles[0];
  first.posts[0].html = '<p>the cat...</p>';
  first.posts[0].media = [];
  const id = '100000000000000099';
  first.posts.push({
    ...first.posts[0], id, parentId: first.id, html: '<p>...sat on the mat.</p>',
    url: `https://example.test/@author/${id}`, uri: `https://example.test/users/author/statuses/${id}`,
  });
  for (const format of ['html', 'md']) {
    const result = await prepareArchive(source, { format });
    const manifest = JSON.parse(result.files.get('manifest.json'));
    assert.equal(manifest.joinContinuations, true);
    assert.deepEqual(manifest.articles[0].statuses, [first.id, id]);
    const all = result.files.get(`all.${format}`);
    assert.ok(all.includes('the cat sat on the mat.'));
    assert.ok(all.includes(`id="s-${first.file}-${id}"`));
    assert.ok(result.files.get(`posts/${first.file}.${format}`).includes(`id="s-${id}"`));
    checkLinks(result.files, format);
  }
});
