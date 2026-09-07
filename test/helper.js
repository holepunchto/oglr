const fs = require('bare-fs')
const os = require('bare-os')
const { isWindows } = require('which-runtime')
const path = require('bare-path')
const { spawn: spawnRuntime } = require('bare-subprocess')

let HOME = null
try {
  HOME = os.homedir()
} catch {}
const BIN = path.join(__dirname, '..', 'bin.mjs')
const FIXTURES = path.join(__dirname, 'fixtures')

fs.mkdirSync(path.join(FIXTURES, 'tree', 'empty'), { recursive: true })

function abbrev(p) {
  if (HOME && (p === HOME || p.startsWith(HOME + '/'))) return '~' + p.slice(HOME.length)
  return p
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oglr-test-'))
  t.teardown(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return dir
}

function clean(s) {
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')
}

function session(t, source, commands = []) {
  const stdin = commands.concat('exit').join('\n') + '\n'
  return spawn(t, [source, '--storage', scratch(t), '--no-updates'], stdin)
}

function oneshot(t, source, argv) {
  return spawn(t, [source, '--storage', scratch(t), '--no-updates', ...argv], '')
}

module.exports = { HOME, BIN, FIXTURES, abbrev, scratch, clean, session, oneshot }

function spawn(t, args, stdin) {
  const out = isWindows ? 'overlapped' : 'pipe'
  const sc = spawnRuntime(Bare.argv[0], [BIN, ...args], { stdio: ['pipe', out, out] })

  let stdout = ''
  let stderr = ''
  sc.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  sc.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  t.teardown(() => {
    try {
      sc.kill()
    } catch {}
  })

  sc.stdin.end(stdin)

  return new Promise((resolve) => {
    sc.on('exit', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}
