import { parseHtml, seriesDocuments, safeHttpUrl } from './export.js';

export const IMAGE_LIMITS = { perImage: 10 * 1024 * 1024, total: 50 * 1024 * 1024 };

export function imageSources(model) {
  const sources = new Set();
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.tag === 'img' && n.attrs.src) sources.add(n.attrs.src);
      if (n.children) visit(n.children);
    }
  };
  for (const article of model.articles) for (const p of [...article.posts, ...article.replies]) {
    visit(parseHtml(p.html));
    for (const m of p.media) if (m.type === 'image' && m.url) sources.add(m.url);
  }
  return [...sources].sort();
}

function imageExtension(bytes) {
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'webp';
  if (text(4, 8) === 'ftyp' && /avif|avis/.test(text(8, 32))) return 'avif';
  throw new Error('Not a supported raster image (PNG, JPEG, GIF, WebP or AVIF).');
}

function assetKey(url) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(url)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

async function downloadImage(url, { signal, maxBytes }) {
  if (!safeHttpUrl(url)) throw new Error('Image URL is not a public HTTP(S) address.');
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => ctrl.abort(new Error('Image download timed out.')), 15000);
  try {
    const response = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const error = new Error(`Image server returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/apng'].includes(type)) {
      throw new Error('Image server returned an unsupported content type.');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Image exceeds the remaining download size limit.');
    if (!response.body) throw new Error('Image response has no readable body.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Image exceeds the remaining download size limit.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, extension: imageExtension(bytes) };
  } catch (err) {
    if (!signal?.aborted && ctrl.signal.aborted) throw new Error('Image download timed out.', { cause: err });
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    ctrl.abort();
  }
}

export async function prepareArchive(model, { format, signal, onProgress = () => {}, cache = new Map(), limits = IMAGE_LIMITS } = {}) {
  const sources = imageSources(model);
  const assets = new Map(), omissions = [], paths = new Map();
  let totalBytes = 0;
  let rateLimited = false;
  for (const article of model.articles) for (const p of [...article.posts, ...article.replies]) {
    for (const m of p.media) if (m.unavailable) omissions.push({ url: p.url || `Post ${p.id}`, reason: m.unavailable });
  }
  onProgress({ phase: 'Collecting images and emoji', completed: 0, total: sources.length });
  for (const [index, url] of sources.entries()) {
    signal?.throwIfAborted();
    try {
      const maxBytes = Math.min(limits.perImage, limits.total - totalBytes);
      if (maxBytes <= 0) throw new Error('The archive image budget has been reached.');
      if (rateLimited && !cache.has(url)) throw new Error('Image downloads paused after a rate limit. Retry later.');
      const asset = cache.get(url) || await downloadImage(url, { signal, maxBytes });
      signal?.throwIfAborted();
      if (asset.bytes.length > maxBytes) throw new Error('Image exceeds the remaining download size limit.');
      const path = `assets/${assetKey(url)}.${asset.extension}`;
      if (paths.has(path) && paths.get(path) !== url) throw new Error('Image filename collision; this image was not bundled.');
      paths.set(path, url);
      cache.set(url, asset);
      assets.set(url, { ...asset, path });
      totalBytes += asset.bytes.length;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err.status === 429) rateLimited = true;
      omissions.push({ url, reason: err.message || String(err) });
    }
    onProgress({ phase: 'Collecting images and emoji', completed: index + 1, total: sources.length });
  }
  signal?.throwIfAborted();
  const files = seriesDocuments(model, { format, assets, omissions });
  for (const asset of assets.values()) files.set(asset.path, asset.bytes);
  const partial = !model.complete || model.warnings.length > 0 || omissions.length > 0;
  const slug = model.tag.normalize('NFKD').replace(/[^\w-]/g, '').slice(0, 60) || 'collection';
  return { files, omissions, warnings: model.warnings, partial, name: `${slug}${partial ? '-partial' : ''}-${format}.zip` };
}
