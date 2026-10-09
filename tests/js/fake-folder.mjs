// A folder of the network as the File System Access API gives it, in memory,
// for the tests of what the page writes in the shared folder
// (web/network-folder.js and its users).

/**
 * A folder: {name: text or bytes, or a folder of its own}. `hooks.write(name,
 * attempt)` may throw to stand for a network or a file held by another PC.
 * The folder's `files` maps the names of its files to their bytes.
 */
export function fakeFolder(content = {}, { name = 'dossier', hooks = {} } = {}) {
  const files = new Map();
  const folders = new Map();
  const writes = new Map(); // name -> attempts
  const bytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
  for (const [k, v] of Object.entries(content)) {
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && v.kind === 'directory') folders.set(k, v);
    else files.set(k, { bytes: bytes(v), lastModified: 1 });
  }
  let clock = 1;
  const fileHandle = (n) => ({
    kind: 'file',
    name: n,
    async getFile() {
      const f = files.get(n);
      if (!f) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      return new File([f.bytes], n, { lastModified: f.lastModified });
    },
    async createWritable() {
      const attempt = (writes.get(n) ?? 0) + 1;
      writes.set(n, attempt);
      hooks.write?.(n, attempt);
      const parts = [];
      const stream = new WritableStream({
        write(chunk) {
          parts.push(bytes(chunk));
        },
        close() {
          const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
          let at = 0;
          for (const p of parts) {
            all.set(p, at);
            at += p.length;
          }
          files.set(n, { bytes: all, lastModified: ++clock });
        },
      });
      // FileSystemWritableFileStream: write() of its own, close() and abort() of WritableStream.
      stream.write = async (data) => {
        const writer = stream.getWriter();
        await writer.write(data);
        writer.releaseLock();
      };
      return stream;
    },
  });
  return {
    kind: 'directory',
    name,
    files,
    folders,
    writes,
    text: (n) => new TextDecoder().decode(files.get(n).bytes),
    async getFileHandle(n, { create = false } = {}) {
      if (!files.has(n)) {
        if (!create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        files.set(n, { bytes: new Uint8Array(0), lastModified: ++clock });
      }
      return fileHandle(n);
    },
    async getDirectoryHandle(n, { create = false } = {}) {
      if (!folders.has(n)) {
        if (!create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        folders.set(n, fakeFolder({}, { name: n, hooks }));
      }
      return folders.get(n);
    },
    async *values() {
      for (const n of [...files.keys()]) yield fileHandle(n);
      for (const folder of folders.values()) yield folder;
    },
  };
}
