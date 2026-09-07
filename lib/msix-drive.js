const zlib = require('bare-zlib')
const { Readable } = require('streamx')
const MirrorDrive = require('mirror-drive')

module.exports = class MsixDrive {
  // msix IS zip
  static fromBytes(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null
    return new MsixDrive(bytes)
  }

  constructor(bytes) {
    this._files = new Map() // key -> { data, executable }

    const eocd = findEOCD(bytes)
    if (eocd === -1) return

    const count = bytes.readUInt16LE(eocd + 10)
    let ptr = bytes.readUInt32LE(eocd + 16) // start of central directory

    for (let i = 0; i < count; i++) {
      if (ptr + 46 > bytes.length || bytes.readUInt32LE(ptr) !== 0x02014b50) break

      const method = bytes.readUInt16LE(ptr + 10)
      const csize = bytes.readUInt32LE(ptr + 20)
      const nameLen = bytes.readUInt16LE(ptr + 28)
      const extraLen = bytes.readUInt16LE(ptr + 30)
      const commentLen = bytes.readUInt16LE(ptr + 32)
      const external = bytes.readUInt32LE(ptr + 38)
      const localOff = bytes.readUInt32LE(ptr + 42)
      const name = bytes.toString('utf8', ptr + 46, ptr + 46 + nameLen)
      ptr += 46 + nameLen + extraLen + commentLen

      if (name.endsWith('/')) continue // directory (implicit)

      // Data is located via the local header, whose extra field length may
      // differ from the central directory's.
      if (localOff + 30 > bytes.length || bytes.readUInt32LE(localOff) !== 0x04034b50) continue
      const start =
        localOff + 30 + bytes.readUInt16LE(localOff + 26) + bytes.readUInt16LE(localOff + 28)
      const raw = bytes.subarray(start, start + csize)

      let data
      if (method === 0) {
        data = raw
      } else if (method === 8) {
        try {
          data = zlib.inflateRawSync(raw)
        } catch {
          continue
        }
      } else {
        continue // unsupported compression method
      }

      const mode = external >>> 16 // unix mode in the high 16 bits
      this._files.set('/' + name.replace(/^\/+/, ''), { data, executable: (mode & 0o111) !== 0 })
    }
  }

  ready() {}
  close() {}

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

function findEOCD(bytes) {
  const MIN = 22
  if (bytes.length < MIN) return -1
  const floor = Math.max(0, bytes.length - (MIN + 0xffff))
  for (let i = bytes.length - MIN; i >= floor; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}
