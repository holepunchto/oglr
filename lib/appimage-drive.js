const zlib = require('bare-zlib')
const { Readable } = require('streamx')
const MirrorDrive = require('mirror-drive')

module.exports = class AppImageDrive {
  // ELF (7f 45 4c 46) with the AppImage magic "AI" + type (1 or 2) at offset 8.
  static fromBytes(bytes) {
    const ok =
      bytes.length > 10 &&
      bytes[0] === 0x7f &&
      bytes[1] === 0x45 &&
      bytes[2] === 0x4c &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x41 &&
      bytes[9] === 0x49 &&
      (bytes[10] === 0x01 || bytes[10] === 0x02)
    return ok ? new AppImageDrive(bytes) : null
  }

  constructor(bytes) {
    this._files = new Map() // key -> { data, executable }

    const base = findSquashfs(bytes)
    if (base === -1) return

    const blockSize = bytes.readUInt32LE(base + 12)
    const compressor = bytes.readUInt16LE(base + 20)
    if (compressor !== 1) return // only gzip
    const inodeTable = base + num(bytes, base + 64)
    const dirTable = base + num(bytes, base + 72)
    const rootRef = bytes.readBigUInt64LE(base + 32)

    const ctx = { bytes, base, blockSize, inodeTable, dirTable }
    walk(ctx, Number(rootRef >> 16n), Number(rootRef & 0xffffn), '', this._files)
  }

  ready() {} // compat
  close() {} // compat

  entry(name) {
    if (name && typeof name === 'object') name = name.key
    const key = normalize(name)
    const file = this._files.get(key)
    return file ? toEntry(key, file) : null
  }

  get(name) {
    if (name && typeof name === 'object') name = name.key
    const file = this._files.get(normalize(name))
    return file ? file.data : null
  }

  async *list(folder) {
    const prefix = normalize(typeof folder === 'string' ? folder : '/')
    const bound = prefix === '/' ? '/' : prefix + '/'
    for (const [key, file] of this._files) {
      if (bound !== '/' && key !== prefix && !key.startsWith(bound)) continue
      yield toEntry(key, file)
    }
  }

  createReadStream(name, opts = {}) {
    if (name && typeof name === 'object') name = name.key
    const file = this._files.get(normalize(name))
    const data = file ? file.data : Buffer.alloc(0)
    const start = opts.start || 0
    const end = typeof opts.end === 'number' ? opts.end + 1 : data.byteLength
    return Readable.from(data.subarray(start, end))
  }

  mirror(out, opts) {
    return new MirrorDrive(this, out, opts)
  }
}

function walk(ctx, block, offset, prefix, files) {
  const inode = readInode(ctx, block, offset)
  if (inode === null || (inode.type !== 1 && inode.type !== 8)) return // not a directory

  const meta = new Meta(ctx.bytes, ctx.dirTable + inode.dirStart)
  const listing = meta.read(inode.dirOffset, inode.size - 3)

  let p = 0
  while (p + 12 <= listing.length) {
    const count = listing.readUInt32LE(p) + 1
    const start = listing.readUInt32LE(p + 4) // inode metadata block for these entries
    p += 12

    for (let i = 0; i < count && p + 8 <= listing.length; i++) {
      const entryOffset = listing.readUInt16LE(p)
      const nameLen = listing.readUInt16LE(p + 6) + 1
      const name = listing.toString('utf8', p + 8, p + 8 + nameLen)
      p += 8 + nameLen

      const child = readInode(ctx, start, entryOffset)
      if (child === null) continue
      if (child.type === 1 || child.type === 8) {
        walk(ctx, start, entryOffset, prefix + '/' + name, files)
      } else if (child.type === 2 || child.type === 9) {
        files.set(prefix + '/' + name, {
          data: readFileData(ctx, child),
          executable: (child.mode & 0o111) !== 0
        })
      }
      // symlinks/devices/etc. are skipped
    }
  }
}

function readInode(ctx, block, offset) {
  const meta = new Meta(ctx.bytes, ctx.inodeTable + block)
  const head = meta.read(offset, 16)
  const type = head.readUInt16LE(0)
  const mode = head.readUInt16LE(2)

  if (type === 1) {
    const b = meta.read(offset, 32) // basic directory
    return {
      type,
      mode,
      dirStart: b.readUInt32LE(16),
      size: b.readUInt16LE(24),
      dirOffset: b.readUInt16LE(26)
    }
  }
  if (type === 8) {
    const b = meta.read(offset, 40) // extended directory
    return {
      type,
      mode,
      size: b.readUInt32LE(20),
      dirStart: b.readUInt32LE(24),
      dirOffset: b.readUInt16LE(34)
    }
  }
  if (type === 2) {
    const fixed = meta.read(offset, 32) // basic file
    const blocksStart = fixed.readUInt32LE(16)
    const fragment = fixed.readUInt32LE(20)
    const size = fixed.readUInt32LE(28)
    const nblocks =
      fragment === 0xffffffff ? Math.ceil(size / ctx.blockSize) : Math.floor(size / ctx.blockSize)
    const b = meta.read(offset, 32 + nblocks * 4)
    const blockSizes = []
    for (let i = 0; i < nblocks; i++) blockSizes.push(b.readUInt32LE(32 + i * 4))
    return { type, mode, blocksStart, size, blockSizes }
  }
  if (type === 9) {
    const fixed = meta.read(offset, 56) // extended file
    const blocksStart = num(fixed, 16)
    const size = num(fixed, 24)
    const fragment = fixed.readUInt32LE(44)
    const nblocks =
      fragment === 0xffffffff ? Math.ceil(size / ctx.blockSize) : Math.floor(size / ctx.blockSize)
    const b = meta.read(offset, 56 + nblocks * 4)
    const blockSizes = []
    for (let i = 0; i < nblocks; i++) blockSizes.push(b.readUInt32LE(56 + i * 4))
    return { type, mode, blocksStart, size, blockSizes }
  }

  return { type, mode }
}

function readFileData(ctx, inode) {
  const out = []
  let cursor = ctx.base + inode.blocksStart
  let remaining = inode.size
  for (const bs of inode.blockSizes) {
    const onDisk = bs & 0xffffff
    const uncompressed = (bs & 0x1000000) !== 0
    const take = Math.min(ctx.blockSize, remaining)
    if (onDisk === 0) {
      out.push(Buffer.alloc(take)) // sparse block
    } else {
      const raw = ctx.bytes.subarray(cursor, cursor + onDisk)
      const chunk = uncompressed ? raw : zlib.inflateSync(raw)
      out.push(chunk.subarray(0, take))
      cursor += onDisk
    }
    remaining -= take
  }
  return Buffer.concat(out)
}

class Meta {
  constructor(bytes, start) {
    this.bytes = bytes
    this.pos = start
    this.buf = Buffer.alloc(0)
  }

  read(off, len) {
    while (this.buf.length < off + len) {
      const header = this.bytes.readUInt16LE(this.pos)
      const size = header & 0x7fff
      const raw = this.bytes.subarray(this.pos + 2, this.pos + 2 + size)
      const out = header & 0x8000 ? raw : zlib.inflateSync(raw)
      this.pos += 2 + size
      this.buf = Buffer.concat([this.buf, out])
      if (out.length === 0) break
    }
    return this.buf.subarray(off, off + len)
  }
}

function findSquashfs(bytes) {
  for (let i = 0; i + 96 <= bytes.length; i++) {
    if (
      bytes[i] !== 0x68 ||
      bytes[i + 1] !== 0x73 ||
      bytes[i + 2] !== 0x71 ||
      bytes[i + 3] !== 0x73
    ) {
      continue
    }
    if (bytes.readUInt16LE(i + 28) !== 4) continue // version_major
    const blockSize = bytes.readUInt32LE(i + 12)
    if ((blockSize & (blockSize - 1)) !== 0) continue
    return i
  }
  return -1
}

function num(buf, off) {
  return Number(buf.readBigUInt64LE(off))
}

function toEntry(key, file) {
  return {
    key,
    value: {
      executable: file.executable,
      linkname: null,
      blob: { byteLength: file.data.byteLength },
      metadata: null
    }
  }
}

function normalize(key) {
  if (typeof key !== 'string') return '/'
  return key.startsWith('/') ? key : '/' + key
}
