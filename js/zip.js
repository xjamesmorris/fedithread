export const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});

export function crc32(bytes, previous = 0) {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export async function createZip(files, { signal, onProgress = () => {}, maxBytes = MAX_ZIP_BYTES } = {}) {
  const entries = [];
  const names = new Set();
  let size = 22;
  for (const [path, value] of files) {
    if (typeof path !== 'string' || /[\\:\x00-\x1f\x7f]/.test(path)
        || path.split('/').some((p) => !p || p === '.' || p === '..') || names.has(path)) {
      throw new Error('The archive contains an unsafe or duplicate path.');
    }
    names.add(path);
    const name = encoder.encode(path);
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    if (!(bytes instanceof Uint8Array)) throw new Error('The archive contains unsupported file data.');
    if (name.length > 65535 || bytes.length > 0xffffffff) throw new Error('A file exceeds the supported ZIP format limits.');
    size += 30 + name.length + bytes.length + 46 + name.length;
    if (size > maxBytes || size > 0xffffffff) throw new Error(`The archive exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB size limit. No files were silently removed.`);
    entries.push({ name, bytes });
  }
  if (entries.length > 65535) throw new Error('The archive has too many files for the supported ZIP format.');
  const parts = [], directory = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    signal?.throwIfAborted();
    const { name, bytes } = entries[i];
    let crc = 0;
    for (let pos = 0; pos < bytes.length; pos += 262144) {
      signal?.throwIfAborted();
      crc = crc32(bytes.subarray(pos, pos + 262144), crc);
      if (pos % 1048576 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true);
    l.setUint16(12, 0x21, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, bytes);
    directory.push(central);
    offset += local.length + bytes.length;
    onProgress({ phase: 'Writing ZIP', completed: i + 1, total: entries.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directory.reduce((n, d) => n + d.length, 0), true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
