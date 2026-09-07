const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const ansiEscapes = require('bare-ansi-escapes')
const Localdrive = require('localdrive')
const DistributedDrive = require('distributed-drive')
const unixPathResolve = require('unix-path-resolve')
const { command, arg, flag } = require('paparam')
const { isWindows } = require('which-runtime')
const BundleDrive = require('./lib/bundle-drive')
const Repl = require('./lib/repl')
const toDrive = require('./lib/to-drive')
const RemoteDrive = require('./lib/remote-drive')
const BinaryDrive = require('./lib/binary-drive')
const MsixDrive = require('./lib/msix-drive')
const TarDrive = require('./lib/tar-drive')
const AppImageDrive = require('./lib/appimage-drive')

const HOME = (() => {
  try {
    return os.homedir()
  } catch {
    return null
  }
})()

const FORMATS = [
  [AppImageDrive, 'appimage', '&'],
  [MsixDrive, 'msix', '='],
  [TarDrive, 'tar', '+'],
  [BinaryDrive, 'binary', '%'],
  [RemoteDrive, 'hyperdrive', '@'],
  [BundleDrive, 'bundle', '#']
]

function formatOf(drive) {
  for (const [Cls, name, sigil] of FORMATS) if (drive instanceof Cls) return { name, sigil }
  return { name: 'filesystem', sigil: ':' }
}

function toPath(key) {
  if (!isWindows) return key
  if (key === '/') return '\\'
  if (key.startsWith('//')) return key.replace(/\//g, '\\') // UNC share
  const s = key.startsWith('/') ? key.slice(1) : key
  if (/^[a-z]:$/i.test(s)) return s + '\\' // bare drive means its root, not its cwd
  return s.replace(/\//g, '\\')
}

class OglrRepl extends Repl {
  constructor({ app = null, command: cmd, ...io } = {}) {
    super({ ...io, prompt: './> ' })

    this.app = app
    this.drive = null
    this.cwd = '/'
    this.root = '/'
    this.command = cmd.add(
      command('ls', arg('[path=.]'), this.ls),
      command('cd', arg('<path>'), this.cd),
      command('cat', arg('[path=.]'), this.cat),
      command('pwd', this.pwd),
      command('tree', arg('[path=.]'), this.tree_),
      command(
        'mirror',
        arg('<to>'),
        arg('[from=.]'),
        flag('--force', 'overwrite a non-empty destination'),
        this.mirror
      ),
      command('size', arg('[path=.]'), this.size),
      command('up', this.up),
      command('info', arg('[path=.]'), this.info),
      command('version', this.version)
    )
  }

  async _open() {
    await this._enter()
    this._initReadline()
    this._loadHistory()
    this._reprompt()
    await super._open()
  }

  async _enter() {
    await this.app.ready()
    this.drive = new DistributedDrive(null)
    for (const m of this.app.mounts) this.drive.register(m.drive, m.base)
    this.cwd = this.app.cwd
    this.root = this.app.cwd
  }

  async run(argv) {
    await this._enter()
    const parsed = this.command.parse(argv, { silent: false })
    if (parsed && parsed.running) await parsed.running
  }

  _loadHistory() {
    const dir = this.app.storage
    const file = (dir.endsWith('/') ? dir : dir + '/') + 'history'
    try {
      this.io.rl._history.entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch {}
    this.io.rl.on('history', (entries) => {
      try {
        fs.mkdirSync(this.app.storage, { recursive: true })
        fs.writeFileSync(file, entries.slice(0, 500).join('\n'))
      } catch {}
    })
  }

  async _close() {
    await this.app.close()
    return new Promise((resolve) => this.io.output.write('\n', resolve))
  }

  write(line) {
    this.io.output.write(line + '\n')
  }

  // Out-of-band output (update notices) can land while the user is sat at — or
  // midway through typing at — the prompt. Erase the rendered prompt, print
  // above it, then redraw so partial input survives.
  notify(line) {
    const rl = this.io.rl
    if (rl === null || this.prompting === false) {
      this.write(line)
      return
    }
    if (rl._previousRows) rl.write(ansiEscapes.cursorUp(rl._previousRows))
    rl.write(ansiEscapes.cursorPosition(0) + ansiEscapes.eraseDisplayEnd)
    rl._previousRows = 0
    this.io.output.write(line + '\r\n')
    rl.prompt()
  }

  _reprompt() {
    if (this.io.rl) this.io.rl.setPrompt(this._render(this.cwd) + '> ')
  }

  _render(key) {
    const c = container(this.drive, key)
    if (c) {
      const within = c.base === '/' ? key : key === c.base ? '/' : key.slice(c.base.length)
      const label = c.drive.label || c.base.slice(c.base.lastIndexOf('/') + 1)
      return `${label}${formatOf(c.drive).sigil}${within}`
    }
    const p = toPath(key)
    if (HOME && (p === HOME || p.startsWith(HOME + path.sep))) return '~' + p.slice(HOME.length)
    return p
  }

  completer = async (rl) => {
    const line = rl._line
    const cursor = rl._cursor
    const left = line.slice(0, cursor)
    const sp = left.lastIndexOf(' ')
    const token = left.slice(sp + 1)

    let prefix
    let fragment
    let candidates

    if (sp === -1) {
      prefix = ''
      fragment = token
      candidates = COMMANDS.filter((c) => c.startsWith(fragment))
    } else {
      const slash = token.lastIndexOf('/')
      prefix = slash === -1 ? '' : token.slice(0, slash + 1)
      fragment = slash === -1 ? token : token.slice(slash + 1)
      const dirSpec = slash === -1 ? '.' : token.slice(0, slash) || '/'
      const names = await this._childNames(dirSpec)
      candidates = names.filter((n) => n.startsWith(fragment))
    }

    if (candidates.length === 0) return

    let completion
    if (candidates.length === 1) {
      completion = candidates[0]
      if (sp === -1) completion += ' '
    } else {
      completion = candidates[0]
      for (const s of candidates) {
        let i = 0
        while (i < completion.length && i < s.length && completion[i] === s[i]) i++
        completion = completion.slice(0, i)
        if (completion === '') break
      }
      if (completion.length <= fragment.length) {
        this.io.output.write('\n' + candidates.join('  ') + '\n')
        rl.prompt()
        return
      }
    }

    const before = left.slice(0, left.length - token.length)
    const after = line.slice(cursor)
    const newLeft = before + prefix + completion
    rl._line = newLeft + after
    rl._cursor = newLeft.length
    rl.prompt()
  }

  _childNames = async (dirSpec) => {
    const dir = dirSpec === '.' ? this.cwd : resolveKey(this.cwd, dirSpec)
    try {
      const { dirs, files } = await children(this.drive, dir)
      return dirs.map((d) => d + '/').concat(files.map((f) => f.name))
    } catch {
      return []
    }
  }

  async _resolve(spec) {
    if (spec === undefined || spec === null || spec === true) spec = '.'
    if (typeof spec === 'string' && spec.startsWith('pear://')) return null // sources only
    const key = resolveKey(this.cwd, spec)

    const c = container(this.drive, key)
    if (c && c.base === key) return { key, isDir: true, fs: false }

    const m = covering(this.drive, key)
    if (m && m.drive instanceof Localdrive) {
      const st = statOrNull(toPath(key))
      return st ? { key, isDir: st.isDirectory(), fs: true } : null
    }

    const base = key === '/' ? '/' : key + '/'
    for await (const entry of this.drive.list(key)) {
      if (entry && entry.key && entry.key !== key && entry.key.startsWith(base)) {
        return { key, isDir: true, fs: false }
      }
    }

    const entry = await this.drive.entry(key)
    if (entry) return { key, isDir: false, fs: false, entry }

    return null
  }

  ls = async ({ args }) => {
    const t = await this._resolve(args.path)
    if (t === null) {
      this.write(`not found: ${args.path}`)
      return
    }
    if (!t.isDir) {
      this.write(`${t.key} is a file — use 'cat'`)
      return
    }

    const { dirs, files } = await children(this.drive, t.key)
    if (dirs.length === 0 && files.length === 0) {
      this.write('  (empty)')
      return
    }

    for (const d of dirs) this.write(`  ${d}/`)
    for (const f of files) this.write(`  ${f.name}  ${human(f.size)}`)
  }

  cd = async ({ args }) => {
    const spec = args.path
    const t = await this._resolve(spec)
    if (t === null) {
      this.write(`no such path: ${spec}`)
      return
    }

    if (t.isDir) {
      this.cwd = t.key
      this._reprompt()
      return
    }

    // A file: descend into it if it is itself a container (mount it, then enter).
    const mounted = await mountContainer(this.drive, t.key)
    if (mounted) {
      this.cwd = t.key
      this._reprompt()
      return
    }

    this.write(`not a container: ${t.key} (use 'cat' to view it)`)
  }

  cat = async ({ args }) => {
    const spec = args.path
    if (spec === undefined) {
      this.write('cat needs a file path')
      return
    }

    const t = await this._resolve(spec)
    if (t === null || t.isDir) {
      this.write(`no such file: ${spec}`)
      return
    }

    const bytes = await readKey(this.drive, t.key)
    if (bytes === null) {
      this.write(`no such file: ${t.key}`)
      return
    }
    const scan = Math.min(bytes.byteLength, 4096)
    let binary = false
    for (let i = 0; i < scan; i++) {
      if (bytes[i] === 0) {
        binary = true
        break
      }
    }
    if (binary) {
      this.write(
        `(binary file, ${human(bytes.byteLength)}; 'cd' to open it as a container, or 'mirror' to disk)`
      )
      return
    }

    const MAX = 64 * 1024
    const shown = bytes.byteLength > MAX ? bytes.subarray(0, MAX) : bytes
    this.write(shown.toString('utf8'))
    if (bytes.byteLength > MAX) {
      this.write(`… (truncated, ${human(bytes.byteLength)} total)`)
    }
  }

  pwd = () => {
    this.write(this._render(this.cwd))
  }

  info = async ({ args }) => {
    const t = await this._resolve(args.path)
    const key = t ? t.key : this.cwd
    const c = container(this.drive, key)

    this.write(`at     : ${this._render(key)}`)
    this.write(`kind   : ${c ? formatOf(c.drive).name : 'filesystem'}`)

    if (c) {
      const drive = c.drive
      if (drive.id) this.write(`id     : ${drive.id}`)
      if (drive.main) this.write(`main   : ${drive.main}`)
      if (Array.isArray(drive.addons) && drive.addons.length) {
        this.write(`addons : ${drive.addons.length}`)
      }
      let files = 0
      for await (const _ of drive.list('/')) files++
      this.write(`files  : ${files}`)
    }
  }

  version = async () => {
    const { version, link } = await this.app.status()
    this.write(`version: ${version || 'unknown'}`)
    this.write(`link   : ${link || 'unknown'}`)
  }

  tree_ = async ({ args }) => {
    const t = await this._resolve(args.path)
    if (t === null || !t.isDir) {
      this.write(`not a directory: ${args.path}`)
      return
    }
    await this._walk(t.key, '')
  }

  _walk = async (dir, indent) => {
    const { dirs, files } = await children(this.drive, dir)
    for (const d of dirs) {
      this.write(`${indent}${d}/`)
      await this._walk(dir === '/' ? '/' + d : dir + '/' + d, indent + '  ')
    }
    for (const f of files) this.write(`${indent}${f.name}`)
  }

  mirror = async ({ args, flags }) => {
    const t = await this._resolve(args.from)
    if (t === null) {
      this.write('mirror source not found')
      return
    }

    const dest = statOrNull(args.to)
    const occupied = dest !== null && (!dest.isDirectory() || fs.readdirSync(args.to).length > 0)
    if (!flags.force && occupied) {
      this.write(`refusing to mirror into non-empty ${args.to} (pass --force to overwrite)`)
      return
    }

    const m = covering(this.drive, t.key)
    const local = m.base === '/' ? t.key : t.key === m.base ? '/' : t.key.slice(m.base.length)
    const out = new Localdrive(args.to)

    // A filesystem subtree cannot be addressed as a prefix of the root
    // Localdrive: on Windows the key is not a valid path beneath it, and
    // everywhere it recreates the whole absolute path inside the destination.
    // Root a drive at the subtree itself instead.
    const subtree = t.fs && t.isDir
    const src = subtree ? new Localdrive(toPath(t.key)) : m.drive
    const opts = !subtree && t.isDir && local !== '/' ? { prefix: local } : {}

    let files = 0
    let bytes = 0
    for await (const op of src.mirror(out, opts)) {
      if (op.op === 'add' || op.op === 'change') {
        files++
        bytes += op.bytesAdded
      }
      this.write(`${op.op} ${op.key}`)
    }
    this.write(`mirrored ${files} files (${human(bytes)}) -> ${args.to}`)
  }

  size = async ({ args }) => {
    const t = await this._resolve(args.path)
    if (t === null) {
      this.write(`not found: ${args.path}`)
      return
    }

    if (!t.isDir) {
      let bytes = 0
      if (t.fs) {
        const st = statOrNull(toPath(t.key))
        bytes = st ? st.size : 0
      } else {
        const entry = t.entry || (await this.drive.entry(t.key))
        bytes = entry && entry.value.blob ? entry.value.blob.byteLength : 0
      }
      this.write(`${human(bytes)}  ${t.key.slice(t.key.lastIndexOf('/') + 1)}`)
      return
    }

    let bytes = 0
    let files = 0
    if (t.fs) {
      const stack = [t.key]
      while (stack.length > 0) {
        const d = stack.pop()
        let entries
        try {
          entries = fs.readdirSync(toPath(d), { withFileTypes: true })
        } catch {
          continue
        }
        for (const dirent of entries) {
          const full = d === '/' ? '/' + dirent.name : d + '/' + dirent.name
          if (dirent.isDirectory()) {
            stack.push(full)
          } else {
            try {
              bytes += fs.statSync(toPath(full)).size
              files++
            } catch {}
          }
        }
      }
    } else {
      const base = t.key === '/' ? '/' : t.key + '/'
      for await (const entry of this.drive.list(t.key)) {
        if (!entry || !entry.key) continue
        if (t.key !== '/' && entry.key !== t.key && !entry.key.startsWith(base)) continue
        if (entry.value.blob) {
          bytes += entry.value.blob.byteLength
          files++
        }
      }
    }
    this.write(`${human(bytes)} in ${files} ${files === 1 ? 'file' : 'files'}`)
  }

  up = () => {
    if (this.cwd === this.root) {
      this.write('already at the top')
      return
    }
    this.cwd = resolveKey(this.cwd, '..')
    this._reprompt()
  }
}

async function children(drive, dir) {
  const m = covering(drive, dir)
  if (m && m.drive instanceof Localdrive) {
    let entries
    try {
      entries = fs.readdirSync(toPath(dir), { withFileTypes: true })
    } catch {
      return { dirs: [], files: [] }
    }

    const dirs = []
    const files = []
    for (const dirent of entries) {
      if (dirent.isDirectory()) {
        dirs.push(dirent.name)
        continue
      }
      const full = dir === '/' ? '/' + dirent.name : dir + '/' + dirent.name
      let size = 0
      let executable = false
      try {
        const st = fs.statSync(toPath(full))
        size = st.size
        executable = (st.mode & 0o100) !== 0
      } catch {}
      files.push({ name: dirent.name, key: full, size, executable })
    }

    return {
      dirs: dirs.sort(),
      files: files.sort((a, b) => (a.name < b.name ? -1 : 1))
    }
  }

  const base = dir === '/' ? '/' : dir + '/'
  const dirs = new Set()
  const files = new Map()
  for await (const entry of drive.list(dir)) {
    if (!entry || !entry.key) continue
    const key = entry.key
    if (key === dir || !key.startsWith(base)) continue

    const rel = key.slice(base.length)
    const slash = rel.indexOf('/')
    if (slash === -1) {
      files.set(rel, {
        name: rel,
        key,
        size: entry.value.blob ? entry.value.blob.byteLength : 0,
        executable: !!entry.value.executable
      })
    } else {
      dirs.add(rel.slice(0, slash))
    }
  }

  return {
    dirs: [...dirs].sort(),
    files: [...files.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  }
}

function covers(base, key) {
  if (base === '/') return true
  return key === base || key.startsWith(base + '/')
}

function mountsOf(drive) {
  return drive.drives
    .map((d) => ({ drive: d, base: drive._mounts.get(d) || '/' }))
    .sort((a, b) => b.base.length - a.base.length)
}

function covering(drive, key) {
  for (const m of mountsOf(drive)) if (covers(m.base, key)) return m
  return null
}

function container(drive, key) {
  for (const m of mountsOf(drive)) {
    if (m.drive instanceof Localdrive) continue
    if (covers(m.base, key)) return m
  }
  return null
}

// lazy:
async function mountContainer(drive, key) {
  if (mountsOf(drive).some((m) => m.base === key)) return container(drive, key)
  const bytes = await readKey(drive, key)
  if (!bytes) return null
  const found = toDrive(bytes)
  if (!found) return null
  found.ready()
  drive.register(found, key)
  return container(drive, key)
}

// A key under the root Localdrive names a real file, but that drive is rooted
// at '/' and cannot express a Windows path — so read those through fs instead.
function readKey(drive, key) {
  const m = covering(drive, key)
  if (m && m.drive instanceof Localdrive) {
    try {
      return fs.readFileSync(toPath(key))
    } catch {
      return null
    }
  }
  return drive.get(key)
}

function resolveKey(cwd, spec) {
  try {
    return unixPathResolve(cwd, spec)
  } catch {
    return '/' // climbing above the root clamps here rather than throwing
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function human(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

const COMMANDS = [
  'ls',
  'cd',
  'cat',
  'tree',
  'mirror',
  'size',
  'info',
  'version',
  'pwd',
  'up',
  'help',
  'exit'
]

module.exports = OglrRepl
