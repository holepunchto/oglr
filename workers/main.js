const RPC = require('bare-rpc')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperdrive = require('hyperdrive')
const PearRuntime = require('pear-runtime')
const plink = require('pear-link')
const toDrive = require('../lib/to-drive')
const verlink = require('../lib/verlink')
const { INIT, OPEN, ENTRY, GET, LIST, CLOSE, UPDATE, VERSION } = require('../lib/commands')

let store = null
let swarm = null
let pear = null
let config = null

const handles = new Map()
let nextHandle = 1

const rpc = new RPC(Bare.IPC, onrequest)

async function onrequest(req) {
  try {
    switch (req.command) {
      case INIT:
        return onInit(req)
      case OPEN:
        return await onOpen(req)
      case ENTRY:
        return await onEntry(req)
      case GET:
        return await onGet(req)
      case LIST:
        return await onList(req)
      case CLOSE:
        return onClose(req)
      case VERSION:
        return await onVersion(req)
      default:
        req.reply(JSON.stringify({ error: 'unknown command ' + req.command }))
    }
  } catch (err) {
    // GET expects raw bytes; everything else a JSON envelope.
    if (req.command === GET) req.reply(Buffer.alloc(0))
    else req.reply(JSON.stringify({ error: err.message }))
  }
}

function onInit(req) {
  const opts = JSON.parse(req.data.toString())
  config = opts

  store = new Corestore(opts.storage)
  swarm = new Hyperswarm({ bootstrap: opts.bootstrap })
  swarm.on('connection', (connection) => store.replicate(connection))

  // Reply before starting the updater so REPL startup never waits on the network.
  req.reply(JSON.stringify({ ok: true }))

  if (opts.updates !== false) startUpdater(opts)
}

// Peer-to-peer OTA updates via pear-runtime, reusing this worker's store and
// swarm. Update lifecycle is forwarded to the main process over RPC (UPDATE).
async function startUpdater(opts) {
  try {
    pear = new PearRuntime({
      dir: opts.storage,
      store,
      swarm,
      version: opts.version,
      upgrade: opts.upgrade,
      name: opts.name,
      app: opts.app || null
    })

    pear.on('error', () => {}) // ignore network errors

    pear.updater.on('updating', () => notify('updating'))
    pear.updater.on('updated', async () => {
      notify('updated')
      try {
        await pear.updater.applyUpdate()
        notify('update-applied')
      } catch (err) {
        notify('update-error', err.message)
      }
    })

    await pear.ready()
    swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false })
  } catch {
    // updater unavailable; inspection still works without it
  }
}

function notify(event, message = null) {
  const req = rpc.request(UPDATE)
  req.send(JSON.stringify({ event, message }))
}

// Current semver plus the live version link. The updater's own `link` is built
// once at construction and never recomputed, so read fork/length off the core.
async function onVersion(req) {
  const version = (pear && pear.updater.version) || (config && config.version) || null
  let link = null

  if (pear) {
    try {
      await pear.updater.ready()
      const core = pear.updater.drive.core
      link = verlink.serialize({ fork: core.fork, length: core.length, key: pear.updater.key })
    } catch {}
  }

  // No updater (dev run, --no-updates, or it failed to start): report the
  // configured upgrade link, normalised to the same fork.length.key shape.
  if (link === null && config && config.upgrade) {
    try {
      link = verlink.fromLink(config.upgrade)
    } catch {}
  }

  req.reply(JSON.stringify({ version, link }))
}

async function onOpen(req) {
  const { link, timeout = 30000 } = JSON.parse(req.data.toString())
  const parsed = plink.parse(link)
  let drive = new Hyperdrive(store.session(), parsed.drive.key)
  await drive.ready()

  const done = drive.findingPeers()
  swarm.join(drive.discoveryKey, { server: false, client: true })
  swarm.flush().then(done, done)

  await Promise.race([
    drive.core.update({ wait: true }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeout))
  ])

  if (parsed.drive.length) drive = drive.checkout(parsed.drive.length)

  let served = drive
  let prefix = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/'

  // A pear path may point directly at an embedded .bundle or binary.
  if (prefix !== '/') {
    const entry = await drive.entry(prefix)
    if (entry && entry.value.blob) {
      const bytes = await drive.get(prefix)
      const found = bytes && toDrive(bytes)
      if (found) {
        served = found
        prefix = '/'
        await served.ready()
      }
    }
  }

  const handle = nextHandle++
  handles.set(handle, served)

  const meta = { handle, prefix, label: link }
  if (served.id) meta.id = served.id
  if (served.main) meta.main = served.main
  if (Array.isArray(served.addons)) meta.addons = served.addons

  req.reply(JSON.stringify(meta))
}

async function onEntry(req) {
  const { handle, key } = JSON.parse(req.data.toString())
  const drive = handles.get(handle)
  const entry = drive ? await drive.entry(key) : null
  req.reply(JSON.stringify({ entry: entry ? serializeEntry(entry) : null }))
}

async function onGet(req) {
  const { handle, key } = JSON.parse(req.data.toString())
  const drive = handles.get(handle)
  const bytes = drive ? await drive.get(key) : null
  req.reply(bytes || Buffer.alloc(0))
}

async function onList(req) {
  const { handle, folder } = JSON.parse(req.data.toString())
  const drive = handles.get(handle)

  const out = []
  if (drive) {
    for await (const entry of drive.list(folder)) {
      out.push(serializeEntry(entry))
    }
  }
  req.reply(JSON.stringify(out))
}

function onClose(req) {
  const { handle } = JSON.parse(req.data.toString())
  const drive = handles.get(handle)
  handles.delete(handle)
  if (drive && drive !== null && typeof drive.close === 'function' && drive.kind !== undefined) {
    // only close drives we own the session for (hyperdrive checkouts/sessions)
  }
  req.reply(JSON.stringify({ ok: true }))
}

function serializeEntry(entry) {
  const value = entry.value || {}
  return {
    key: entry.key,
    value: {
      executable: !!value.executable,
      linkname: value.linkname || null,
      blob: value.blob ? { byteLength: value.blob.byteLength } : null,
      metadata: value.metadata || null
    }
  }
}
