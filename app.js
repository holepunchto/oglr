const RPC = require('bare-rpc')
const PearRuntime = require('pear-runtime')
const ReadyResource = require('ready-resource')
const RemoteDrive = require('./lib/remote-drive')
const Localdrive = require('localdrive')
const fs = require('bare-fs')
const path = require('bare-path')
const { fileURLToPath } = require('bare-url')
const { isWindows } = require('which-runtime')
const toDrive = require('./lib/to-drive')
const { INIT, OPEN, UPDATE, VERSION } = require('./lib/commands')

// A worker that dies during startup never answers, leaving the REPL blocked
// before it has printed anything. Time the wait out so the cause is reported
// instead of the process hanging silently.
function settle(promise, what, ms = 8000) {
  let timer = null
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (no response after ${ms}ms)`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

module.exports = class App extends ReadyResource {
  constructor({
    storage,
    updates = false,
    version,
    upgrade,
    name,
    app,
    bootstrap,
    source,
    timeout
  } = {}) {
    super()

    this.storage = storage
    this.updates = updates
    this.version = version
    this.upgrade = upgrade
    this.name = name
    this.app = app
    this.bootstrap = bootstrap
    this.source = source
    this.root = new Localdrive('/')
    this.mounts = null
    this.cwd = null
    this.timeout = null
    this.ipc = null
    this.rpc = null
    this.booted = null
  }

  async _open() {
    this.ipc = PearRuntime.run(require.resolve('./workers/main.js'))
    this.rpc = new RPC(this.ipc, (req) => this._onnotify(req))

    this.ipc.on('error', (err) => this.emit('error', err))

    try {
      await this._boot()
    } catch (err) {
      await this._close()
      throw err
    }
  }

  async _boot() {
    const init = this.rpc.request(INIT)
    init.send(
      JSON.stringify({
        storage: this.storage,
        updates: this.updates,
        version: this.version,
        upgrade: this.upgrade,
        name: this.name,
        app: this.app,
        bootstrap: this.bootstrap
      })
    )

    // The worker only backs pear:// sources and the updater, so track its
    // startup rather than awaiting it: inspecting a local path should not be
    // gated on Corestore and Hyperswarm coming up, and a worker that never
    // starts should fail where it is actually needed.
    this.booted = settle(init.reply(), 'worker did not start').then((reply) => {
      const res = JSON.parse(reply.toString())
      if (res.error) throw new Error(res.error)
    })
    this.booted.catch(() => {}) // awaiters still see it; this just stops a stray rejection

    if (this.source.startsWith('pear:') === false) {
      if (this.source.startsWith('file://')) {
        this.source = fileURLToPath(this.source)
      }

      const abs = path.resolve(this.source)
      let st = null
      try {
        st = fs.statSync(abs)
      } catch {}
      if (st === null) throw new Error('unrecognised source:' + this.source)

      this.mounts = [{ base: '/', drive: this.root, label: '/' }]

      if (st.isDirectory()) {
        this.cwd = toKey(abs)
      } else {
        const found = toDrive(fs.readFileSync(abs))
        if (found === null) throw new Error('unrecognised source:' + this.source)
        this.mounts.push({ base: toKey(abs), drive: found, label: path.basename(abs) })
        this.cwd = toKey(abs)
      }
      return
    }

    await this.booted

    const open = this.rpc.request(OPEN)
    open.send(JSON.stringify({ link: this.source, timeout: this.timeout }))

    const meta = JSON.parse((await open.reply()).toString())
    if (meta.error) throw new Error(meta.error)

    // A pear:// source is its own namespace: the hyperdrive is mounted at the
    // root and the cwd starts at the link's prefix. No filesystem backdrop.
    this.mounts = [
      { base: '/', drive: new RemoteDrive(this.rpc, meta.handle, meta), label: meta.label }
    ]
    this.cwd = meta.prefix || '/'
  }

  // Running semver plus the live version link, from the worker's updater.
  async status() {
    if (this.rpc === null) return { version: this.version || null, link: null }
    await this.booted
    const req = this.rpc.request(VERSION)
    req.send('{}')
    return JSON.parse((await req.reply()).toString())
  }

  // Update lifecycle notifications pushed from the worker.
  _onnotify(req) {
    if (req.command === UPDATE) {
      const { event, message } = JSON.parse(req.data.toString())
      this.emit(event, message)
      req.reply(JSON.stringify({ ok: true }))
      return
    }
    req.reply(JSON.stringify({ error: 'unknown command ' + req.command }))
  }

  _close() {
    const ipc = this.ipc
    this.ipc = null
    this.rpc = null
    return ipc ? ipc.destroy() : undefined
  }
}

function toKey(p) {
  if (!isWindows) return p
  const s = p.replace(/\\/g, '/')
  return s.startsWith('/') ? s : '/' + s
}
