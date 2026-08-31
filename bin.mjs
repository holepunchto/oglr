import process from 'bare-process'
import os from 'bare-os'
import path, { resolve } from 'bare-path'
import { persistent } from 'bare-storage'
import { isWindows } from 'which-runtime'
import { arg, command, flag } from 'paparam'
import verlink from './lib/verlink.js'
import App from './app.js'
import pkg from './package.json'
import OglrRepl from './repl.js'

const appName = pkg.productName || pkg.name

const isDev = path.basename(Bare.argv[0], '.exe') === 'bare'
const argv = Bare.argv.slice(isDev ? 2 : 1)
const source = isSource(argv[0]) ? argv.shift() : '.'

const cmd = command(
  'oglr',
  flag('--storage <dir>', 'custom storage directory'),
  flag('--no-updates', 'disable OTA updates'),
  flag('--version', 'print the version and upgrade link')
)

cmd.parse(argv, { run: false, bails: false, silent: true })

if (cmd.flags.version) {
  const out = `version: ${pkg.version}\nlink   : ${upgradeLink()}\n`
  await new Promise((resolve) => process.stdout.write(out, resolve))
  Bare.exit(0)
}
const updates = cmd.flags.updates !== false
const storage =
  cmd.flags.storage ||
  (isDev ? path.join(os.tmpdir(), 'pear', appName) : path.join(persistent(), appName))

const app = new App({
  source,
  storage,
  updates,
  version: pkg.version,
  upgrade: pkg.upgrade,
  name: isWindows ? appName + '.exe' : appName,
  app: isDev ? null : os.execPath()
})

const oglr = new OglrRepl({
  app,
  command: cmd,
  input: process.stdin,
  output: process.stdout
})

app.on('error', (err) => fail(err))
app.on('updating', () => oglr.notify('[updater] downloading update…'))
app.on('updated', () => oglr.notify('[updater] update downloaded — applying…'))
app.on('update-applied', () => oglr.notify('[updater] update ready — restart oglr to run it'))
app.on('update-error', (message) =>
  oglr.notify(`[updater] update failed${message ? ': ' + message : ''}`)
)

const parsed = cmd.parse(argv, { run: false })

const helped = cmd.flags.help === true || cmd.current?.flags?.help === true
if (helped) Bare.exit(0)

let failed = false

try {
  if (parsed && parsed.name !== 'oglr') {
    await oglr.run(argv)
    await app.close()
  } else {
    await oglr.ready()
    await oglr.close()
  }
} catch (err) {
  fail(err)
}
if (!failed) Bare.exit()

function fail(err) {
  if (failed) return
  failed = true
  process.stderr.write(`oglr: ${explain(err)}\n`, () => Bare.exit(1))
}

function explain(err) {
  const message = (err && err.message) || String(err)
  if (/could not be locked/i.test(message)) {
    return (
      `storage is already in use by another oglr instance:\n  ${storage}\n` +
      `  (pass --storage <dir> to run a second instance elsewhere)`
    )
  }
  return message
}

function upgradeLink() {
  try {
    return verlink.fromLink(pkg.upgrade)
  } catch {
    return 'unknown'
  }
}

function isSource(value) {
  if (typeof value !== 'string' || value[0] === '-') return false
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    path.isAbsolute(value) ||
    value.startsWith('file://') ||
    value.startsWith('pear://') ||
    (isWindows && (value.startsWith('.\\') || value.startsWith('..\\')))
  )
}
