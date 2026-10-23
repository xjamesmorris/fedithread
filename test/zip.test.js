import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip, crc32 } from '../js/zip.js';

test('ZIP stores UTF-8 names and exact text/binary data with correct CRCs', async () => {
  const text = new TextEncoder().encode('123456789');
  assert.equal(crc32(text), 0xcbf43926);
  assert.equal(crc32(text.subarray(4), crc32(text.subarray(0, 4))), 0xcbf43926);
  const binary = new Uint8Array([0, 255, 127, 13, 10, 0]);
  const files = new Map([['README.md', '123456789'], ['assets/日本語.bin', binary]]);
  const blob = await createZip(files);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [name, data] of files) {
    const expected = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 6, true), 0x800);
    assert.equal(view.getUint16(offset + 8, true), 0);
    assert.equal(view.getUint32(offset + 14, true), crc32(expected));
    const length = view.getUint16(offset + 26, true);
    assert.equal(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length)), name);
    assert.deepEqual(bytes.subarray(offset + 30 + length, offset + 30 + length + expected.length), expected);
    offset += 30 + length + expected.length;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint32(bytes.length - 6, true), offset);
});

test('ZIP rejects unsafe/duplicate paths and oversize archives without silently dropping files', async () => {
  for (const path of ['../secret', '/absolute', 'a/../b', 'a\\b', 'a//b', './file', 'C:drive', 'nul\0file']) {
    await assert.rejects(createZip([[path, 'text']]), /unsafe/);
  }
  await assert.rejects(createZip([['same', 'a'], ['same', 'b']]), /duplicate/);
  const files = new Map([['readme.md', 'text']]);
  const blob = await createZip(files);
  assert.equal((await createZip(files, { maxBytes: blob.size })).size, blob.size);
  await assert.rejects(createZip(files, { maxBytes: blob.size - 1 }), /size limit/);
});

test('ZIP generation yields and honors cancellation between entries', async () => {
  const ctrl = new AbortController();
  const progress = [];
  await assert.rejects(createZip(new Map([['a', 'one'], ['b', 'two']]), {
    signal: ctrl.signal, onProgress: (p) => { progress.push(p.completed); ctrl.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(progress, [1]);
});
