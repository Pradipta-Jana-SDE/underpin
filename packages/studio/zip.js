import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A minimal ZIP writer: local header, deflated data, central directory, end record.
 *
 * Hand-written because the studio is dependency-free, and the one library tried here shipped
 * a major version with an incompatible API that took the server down. The format is simple
 * enough that owning it beats tracking someone else's breaking changes.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what the format stores. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** Recursively lists files, skipping anything the caller wants left out. */
export function walkFiles(root, { ignore = [] } = {}) {
  const out = [];
  const skip = (rel) => ignore.some((pattern) => rel === pattern || rel.startsWith(pattern + sep));

  const rec = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (skip(rel)) continue;
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) out.push({ full, rel });
    }
  };
  rec(root);
  return out;
}

/**
 * Builds a zip in memory and returns the buffer.
 *
 * In-memory is fine for what this ships — a generated source tree, tens of megabytes at
 * most, with build output excluded. Streaming would matter if media were included.
 */
export function zipDirectory(root, { ignore = [], extra = [], rewrite = {} } = {}) {
  const files = walkFiles(root, { ignore });
  // Additional trees mounted under a prefix — used to vendor the shared template package
  // so the archive installs without the monorepo around it.
  for (const e of extra) {
    for (const f of walkFiles(e.root, { ignore: e.ignore ?? [] })) {
      files.push({ full: f.full, rel: join(e.prefix, f.rel) });
    }
  }
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = Buffer.from(f.rel.split(sep).join('/'), 'utf8');
    const rewriter = rewrite[f.rel.split(sep).join('/')];
    const raw = rewriter ? Buffer.from(rewriter(readFileSync(f.full, 'utf8')), 'utf8') : readFileSync(f.full);
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store uncompressed when deflate does not help — common for already-compressed
    // media, and it keeps the archive smaller than a pointlessly wrapped copy.
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTime(statSync(f.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);         // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return { buffer: Buffer.concat([...chunks, centralBuf, end]), count: files.length };
}
