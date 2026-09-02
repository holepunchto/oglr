const Bundle = require('bare-bundle')
const { Readable } = require('streamx')
const MirrorDrive = require('mirror-drive')

module.exports = class BundleDrive {
  static fromBytes(bytes) {
    let i = 0
    if (bytes[0] === 0x23 && bytes[1] === 0x21) {
      i = 2
      while (i < bytes.length && bytes[i] !== 0x0a) i++
      i++ // skip the newline
    }
    let d = i
    while (d < bytes.length && bytes[d] >= 0x30 && bytes[d] <= 0x39) d++
    if (!(d > i && bytes[d] === 0x0a && bytes[d + 1] === 0x7b)) return null
    return new BundleDrive(bytes)
  }

  constructor(bundle) {
    this.bundle = Bundle.isBundle(bundle) ? bundle : Bundle.from(bundle)
    this.supportsMetadata = false
    this._files = new Map()
    for (const [rawKey, data, mode] of this.bundle) {
      this._files.set(normalize(rawKey), { data, mode })
    }
  }

  get id() {
    return this.bundle.id
  }

  get main() {
    return this.bundle.main === null ? null : normalize(this.bundle.main)
  }

  get addons() {
    return this.bundle.addons.map((k) => normalize(k))
  }

  ready() {}
  close() {}

  entry(name) {
    if (typeof name === 'object' && name !== null) name = name.key
    const key = normalize(name)
    const file = this._files.get(key)
    if (file === undefined) return null
    return {
      key,
      value: {
        executable: (file.mode & 0o100) !== 0,
        linkname: null,
        blob: { byteLength: file.data.byteLength },
        metadata: null
      }
    }
  }

  get(name) {
    if (typeof name === 'object' && name !== null) name = name.key
    const file = this._files.get(normalize(name))
    return file === undefined ? null : file.data
  }

  async *list(folder) {
    const prefix = normalize(typeof folder === 'string' ? folder : '/')
    const bound = prefix === '/' ? '/' : prefix + '/'
    for (const key of this._files.keys()) {
      if (bound !== '/' && key !== prefix && !key.startsWith(bound)) continue
      yield this.entry(key)
    }
  }

  createReadStream(name, opts = {}) {
    if (typeof name === 'object' && name !== null) name = name.key
    const file = this._files.get(normalize(name))
    const data = file === undefined ? Buffer.alloc(0) : file.data
    const start = opts.start || 0
    const end = typeof opts.end === 'number' ? opts.end + 1 : data.byteLength
    return Readable.from(Buffer.from(data.subarray(start, end)))
  }

  mirror(out, opts) {
    return new MirrorDrive(this, out, opts)
  }
}

function normalize(key) {
  const out = []
  for (const part of String(key).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length) out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}
