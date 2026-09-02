const zlib = require('bare-zlib')
const { Readable } = require('streamx')
const MirrorDrive = require('mirror-drive')

module.exports = class TarDrive {
  // .tar (ustar magic at offset 257) or .tar.gz (gunzip, then confirm ustar).
  static fromBytes(bytes) {
    if (isTar(bytes)) return new TarDrive(bytes)
    if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        const inflated = zlib.gunzipSync(bytes)
        if (isTar(inflated)) return new TarDrive(inflated)
      } catch {}
    }
    return null
  }

  constructor(bytes) {
    this._files = new Map()

    let longName = null
    let paxPath = null

    for (let off = 0; off + 512 <= bytes.length;) {
      const header = bytes.subarray(off, off + 512)
      if (isZeroBlock(header)) break

      const size = readSize(header)
      const type = String.fromCharCode(header[156] || 0x30)
      const dataStart = off + 512
      const data = bytes.subarray(dataStart, dataStart + size)
      off = dataStart + Math.ceil(size / 512) * 512

      if (type === 'L') {
        longName = str(data, 0, data.length) // GNU long name for the next header
        continue
      }
      if (type === 'x' || type === 'g') {
        paxPath = paxRecord(data.toString('utf8'), 'path') // pax extended header
        continue
      }

      let name = paxPath || longName
      if (name === null) {
        const prefix = str(header, 345, 155)
        name = prefix ? prefix + '/' + str(header, 0, 100) : str(header, 0, 100)
      }
      longName = null
      paxPath = null

      // Only regular files; directories are implicit, others are skipped.
      if (name === '' || (type !== '0' && type !== '\0' && type !== '')) continue

      const key =
        '/' +
        name
          .split('/')
          .filter((p) => p !== '' && p !== '.')
          .join('/')
      if (key === '/') continue

      this._files.set(key, { data, executable: (parseOctal(header, 100, 8) & 0o111) !== 0 })
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

function isTar(bytes) {
  return bytes.length >= 512 && bytes.toString('latin1', 257, 262) === 'ustar'
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

function str(buf, off, len) {
  let end = off
  const limit = off + len
  while (end < limit && buf[end] !== 0) end++
  return buf.toString('utf8', off, end)
}

function parseOctal(buf, off, len) {
  const s = str(buf, off, len).trim()
  return s ? parseInt(s, 8) || 0 : 0
}

function readSize(header) {
  // GNU base-256 encoding for large sizes sets the high bit of the first byte.
  if (header[124] & 0x80) {
    let n = 0
    for (let i = 125; i < 136; i++) n = n * 256 + header[i]
    return n
  }
  return parseOctal(header, 124, 12)
}

function paxRecord(text, field) {
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).split(' ').pop() === field) return line.slice(eq + 1)
  }
  return null
}
