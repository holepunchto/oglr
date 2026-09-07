const { Readable } = require('streamx')
const MirrorDrive = require('mirror-drive')
const { ENTRY, GET, LIST, CLOSE } = require('./commands')

module.exports = class RemoteDrive {
  constructor(rpc, handle, meta = {}) {
    this.rpc = rpc
    this.handle = handle
    this.kind = meta.kind || 'drive'
    this.label = meta.label || null
    this.id = meta.id || null
    this.main = meta.main || null
    this.addons = meta.addons || []
    this.supportsMetadata = false
  }

  ready() {
    // noop
  }

  _call(command, payload) {
    const req = this.rpc.request(command)
    req.send(JSON.stringify({ handle: this.handle, ...payload }))
    return req.reply()
  }

  async entry(name) {
    if (typeof name === 'object' && name !== null) name = name.key
    const buf = await this._call(ENTRY, { key: name })
    return JSON.parse(buf.toString()).entry
  }

  async get(name) {
    if (typeof name === 'object' && name !== null) name = name.key
    const buf = await this._call(GET, { key: name })
    return buf.byteLength > 0 ? buf : null
  }

  async exists(name) {
    return (await this.entry(name)) !== null
  }

  async *list(folder) {
    const dir = typeof folder === 'string' ? folder : '/'
    const buf = await this._call(LIST, { folder: dir })
    for (const entry of JSON.parse(buf.toString())) yield entry
  }

  createReadStream(name) {
    if (typeof name === 'object' && name !== null) name = name.key
    const self = this
    return new Readable({
      async read(cb) {
        try {
          const bytes = await self.get(name)
          if (bytes) this.push(bytes)
          this.push(null)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  mirror(out, opts) {
    return new MirrorDrive(this, out, opts)
  }

  async close() {
    try {
      await this._call(CLOSE, {})
    } catch {
      // worker already gone, ignore
    }
  }

  put() {
    return Promise.reject(new Error('RemoteDrive is read-only'))
  }

  del() {
    return Promise.reject(new Error('RemoteDrive is read-only'))
  }
}
