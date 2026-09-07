const { test } = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { HOME, FIXTURES, abbrev, scratch, clean, session, oneshot } = require('./helper')

const TREE = path.join(FIXTURES, 'tree')
const BUNDLE = path.join(FIXTURES, 'app.bundle')
const NOTABUNDLE = path.join(FIXTURES, 'notabundle.txt')
const ARCHIVE_TAR = path.join(FIXTURES, 'archive.tar')
const ARCHIVE_TARGZ = path.join(FIXTURES, 'archive.tar.gz')
const ARCHIVE_ZIP = path.join(FIXTURES, 'archive.zip')
const APPIMAGE = path.join(FIXTURES, 'sample.AppImage')

test('ls lists directories and files with sizes', async (t) => {
  const { stdout } = await session(t, TREE, ['ls'])
  t.ok(stdout.includes('  sub/'), 'shows a directory')
  t.ok(stdout.includes('  empty/'), 'shows an empty directory')
  t.ok(stdout.includes('  a.txt  10 B'), 'shows a file with a human size')
})

test('ls on a file points at cat', async (t) => {
  const { stdout } = await session(t, TREE, ['ls a.txt'])
  t.ok(stdout.includes("is a file — use 'cat'"))
})

test('ls on a missing path reports not found', async (t) => {
  const { stdout } = await session(t, TREE, ['ls nope'])
  t.ok(stdout.includes('not found: nope'))
})

test('ls on an empty directory says empty', async (t) => {
  const { stdout } = await session(t, TREE, ['ls empty'])
  t.ok(stdout.includes('  (empty)'))
})

test('cat prints text file contents', async (t) => {
  const { stdout } = await session(t, TREE, ['cat a.txt'])
  t.ok(stdout.includes('ALPHA_TEXT'))
})

test('cat handles quoted paths with spaces', async (t) => {
  const { stdout } = await session(t, TREE, ['cat "spaced name.txt"', "cat 'spaced name.txt'"])
  const hits = stdout.split('SPACED_CONTENT').length - 1
  t.is(hits, 2, 'both double- and single-quoted forms resolve the file')
})

test('cat detects binary files', async (t) => {
  const { stdout } = await session(t, TREE, ['cat blob.bin'])
  t.ok(stdout.includes('binary file'))
})

test('cat truncates very large text files', async (t) => {
  const { stdout } = await session(t, TREE, ['cat big.txt'])
  t.ok(stdout.includes('truncated'))
})

test('cat without a path complains', async (t) => {
  const { stdout } = await session(t, TREE, ['cat'])
  t.ok(stdout.includes('cat needs a file path'))
})

test('cat on a directory reports no such file', async (t) => {
  const { stdout } = await session(t, TREE, ['cat sub'])
  t.ok(stdout.includes('no such file: sub'))
})

test('cd into a subdirectory moves the prompt there', async (t) => {
  const { stdout } = await session(t, TREE, ['cd sub', 'pwd'])
  t.ok(stdout.includes(abbrev(path.join(TREE, 'sub'))))
})

test('pwd abbreviates paths under $HOME to ~', async (t) => {
  const sub = path.join(TREE, 'sub')
  const { stdout } = await session(t, TREE, ['cd sub', 'pwd'])
  const output = clean(stdout)

  if (HOME && sub.startsWith(HOME + '/')) {
    t.ok(output.includes('~' + sub.slice(HOME.length) + '\n'), 'shows the ~-relative path')
    t.absent(output.includes(sub + '\n'), 'never prints the raw $HOME-prefixed path')
  } else {
    // Repo lives outside $HOME: abbreviation is a no-op and pwd is absolute.
    t.ok(output.includes(sub + '\n'), 'shows the absolute path')
  }
})

test('cd .. climbs back up the filesystem', async (t) => {
  const { stdout } = await session(t, TREE, ['cd sub', 'cd ..', 'pwd'])
  t.ok(clean(stdout).includes(abbrev(TREE) + '\n'), 'pwd reports the parent, not the subdirectory')
})

test('cd into a missing path reports it', async (t) => {
  const { stdout } = await session(t, TREE, ['cd nope'])
  t.ok(stdout.includes('no such path: nope'))
})

test('cd into a plain file is rejected', async (t) => {
  const { stdout } = await session(t, TREE, ['cd a.txt'])
  t.ok(stdout.includes('not a container'))
})

test('up at the top of the stack says so', async (t) => {
  const { stdout } = await session(t, TREE, ['up'])
  t.ok(stdout.includes('already at the top'))
})

test('tree walks the filesystem recursively', async (t) => {
  const { stdout } = await session(t, TREE, ['tree'])
  t.ok(stdout.includes('sub/'), 'lists the directory')
  t.ok(stdout.includes('  b.txt'), 'lists the nested file, indented')
})

test('tree on a file is rejected', async (t) => {
  const { stdout } = await session(t, TREE, ['tree a.txt'])
  t.ok(stdout.includes('not a directory'))
})

test('size of a file prints its size', async (t) => {
  const { stdout } = await session(t, TREE, ['size a.txt'])
  t.ok(stdout.includes('10 B  a.txt'))
})

test('size of a directory totals its files', async (t) => {
  const { stdout } = await session(t, TREE, ['size .'])
  t.ok(/in \d+ files/.test(stdout))
})

test('size of a missing path reports not found', async (t) => {
  const { stdout } = await session(t, TREE, ['size nope'])
  t.ok(stdout.includes('not found: nope'))
})

test('info on a filesystem frame prints metadata', async (t) => {
  const { stdout } = await session(t, TREE, ['info'])
  t.ok(stdout.includes('at     :'), 'location line')
  t.ok(stdout.includes('kind   :'), 'kind line')
})

test('ls lists entries inside a bundle', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['ls'])
  t.ok(stdout.includes('  lib/'), 'nested directory')
  t.ok(stdout.includes('  index.js  11 B'), 'file with size')
})

test('cat reads a file from a bundle', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['cat index.js'])
  t.ok(stdout.includes('BUNDLE_MAIN'))
})

test('cd into a bundle subdirectory and read a nested file', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['cd lib', 'pwd', 'cat util.js'])
  t.ok(stdout.includes('app.bundle#/lib'), 'prompt shows the bundle sigil and nested path')
  t.ok(stdout.includes('BUNDLE_UTIL'), 'reads the nested file')
})

test('cd .. inside a bundle then out to the filesystem', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['cd lib', 'cd ..', 'cd ..', 'pwd'])
  t.ok(
    clean(stdout).includes(abbrev(FIXTURES) + '\n'),
    'climbing out lands on the containing directory'
  )
})

test('info on a bundle reports its kind and main', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['info'])
  t.ok(stdout.includes('kind   : bundle'), 'kind is bundle')
  t.ok(stdout.includes('main   : /index.js'), 'main is reported')
})

test('size of a bundle entry', async (t) => {
  const { stdout } = await session(t, BUNDLE, ['size index.js'])
  t.ok(stdout.includes('11 B  index.js'))
})

test('descending into a bundle file and climbing back out', async (t) => {
  const { stdout } = await session(t, FIXTURES, ['cd app.bundle', 'cat index.js', 'up', 'pwd'])
  t.ok(stdout.includes('BUNDLE_MAIN'), 'cd descended into the bundle and cat worked')
  t.ok(clean(stdout).includes(abbrev(FIXTURES) + '\n'), 'up popped back onto the filesystem')
})

test('accepts a file:// url as a source', async (t) => {
  const { stdout } = await session(t, 'file://' + TREE, ['ls'])
  t.ok(stdout.includes('  sub/'))
})

test('one-shot subcommand runs without the repl', async (t) => {
  const { code, stdout } = await oneshot(t, TREE, ['ls'])
  t.is(code, 0, 'exits cleanly')
  t.ok(stdout.includes('  sub/'))
})

test('one-shot size subcommand', async (t) => {
  const { stdout } = await oneshot(t, TREE, ['size', 'a.txt'])
  t.ok(stdout.includes('10 B  a.txt'))
})

test('version reports the running semver and a version link', async (t) => {
  const { stdout } = await session(t, TREE, ['version'])
  t.ok(/version: \d+\.\d+\.\d+/.test(stdout), 'prints a semver')
  t.ok(/link   : pear:\/\/\d+\.\d+\.\w+/.test(stdout), 'prints a fork.length.key link')
})

test('--version prints without opening a source', async (t) => {
  const { code, stdout } = await oneshot(t, TREE, ['--version'])
  t.is(code, 0, 'exits cleanly')
  t.ok(/version: \d+\.\d+\.\d+/.test(stdout), 'prints a semver')
  t.ok(stdout.includes('link   : pear://'), 'prints a version link')
  t.absent(stdout.includes('  sub/'), 'never enters the repl')
})

test('an unrecognised source exits non-zero with a message', async (t) => {
  const { code, stderr } = await session(t, NOTABUNDLE, [])
  t.ok(stderr.includes('unrecognised source'), 'explains the problem')
  t.is(code, 1, 'non-zero exit')
})

test('mirror copies a bundle into an empty destination', async (t) => {
  const dest = scratch(t) // exists but empty -> allowed
  const { stdout } = await session(t, BUNDLE, [`mirror ${dest}`])
  t.ok(stdout.includes('mirrored'), 'prints a summary')
  t.ok(fs.existsSync(path.join(dest, 'index.js')), 'wrote the main file')
  t.ok(fs.existsSync(path.join(dest, 'lib', 'util.js')), 'wrote a nested file')
})

test('mirror of a filesystem subtree reports what it copied', async (t) => {
  const dest = scratch(t)
  const { stdout } = await session(t, TREE, [`mirror ${dest} sub`])
  t.ok(/mirrored \d+ files/.test(stdout))
  t.ok(fs.existsSync(path.join(dest, 'b.txt')), 'lands at the destination root')
})

test('mirror reports a missing source', async (t) => {
  const { stdout } = await session(t, TREE, [`mirror ${scratch(t)} nope`])
  t.ok(stdout.includes('mirror source not found'))
})

test('mirror refuses a non-empty destination directory', async (t) => {
  const dest = scratch(t)
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'do not clobber me')

  const { stdout } = await session(t, BUNDLE, [`mirror ${dest}`])

  t.ok(stdout.includes('refusing to mirror into non-empty'), 'refuses')
  t.ok(fs.existsSync(path.join(dest, 'keep.txt')), 'left the existing file alone')
  t.absent(fs.existsSync(path.join(dest, 'index.js')), 'did not write anything')
})

test('mirror refuses when the destination is an existing file', async (t) => {
  const dest = path.join(scratch(t), 'in-the-way')
  fs.writeFileSync(dest, 'i am a file')

  const { stdout } = await session(t, BUNDLE, [`mirror ${dest}`])
  t.ok(stdout.includes('refusing to mirror into non-empty'))
})

test('mirror --force overwrites a non-empty destination', async (t) => {
  const dest = scratch(t)
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'existing content')

  const { stdout } = await session(t, BUNDLE, [`mirror ${dest} --force`])

  t.ok(stdout.includes('mirrored'), 'proceeds with --force')
  t.ok(fs.existsSync(path.join(dest, 'index.js')), 'wrote into the non-empty destination')
})

// --- tar / zip / appimage container formats ---------------------------------

test('reads a tar archive', async (t) => {
  const { stdout } = await session(t, ARCHIVE_TAR, [
    'ls',
    'cat README.md',
    'cd dir',
    'pwd',
    'cat nested.txt'
  ])
  t.ok(stdout.includes('  dir/'), 'lists a directory')
  t.ok(stdout.includes('  README.md  10 B'), 'lists a file with size')
  t.ok(stdout.includes('ARC_README'), 'cat a top-level file')
  t.ok(stdout.includes('archive.tar+/dir'), 'prompt shows the tar sigil')
  t.ok(stdout.includes('ARC_NESTED'), 'cat a nested file')
})

test('reads a gzipped tar (.tar.gz)', async (t) => {
  const { stdout } = await session(t, ARCHIVE_TARGZ, [
    'cat README.md',
    'cat dir/nested.txt',
    'info'
  ])
  t.ok(stdout.includes('ARC_README'), 'gzip is transparently inflated')
  t.ok(stdout.includes('ARC_NESTED'))
  t.ok(stdout.includes('kind   : tar'))
})

test('reads a zip / msix', async (t) => {
  const { stdout } = await session(t, ARCHIVE_ZIP, ['ls', 'cd dir', 'pwd', 'cat nested.txt'])
  t.ok(stdout.includes('  README.md  10 B'), 'lists with size')
  t.ok(stdout.includes('archive.zip=/dir'), 'prompt shows the zip/msix sigil')
  t.ok(stdout.includes('ARC_NESTED'))
})

test('reads an AppImage (squashfs)', async (t) => {
  const { stdout } = await session(t, APPIMAGE, [
    'ls',
    'cat README.md',
    'cd dir',
    'pwd',
    'cat nested.txt',
    'info'
  ])
  t.ok(stdout.includes('  dir/'), 'lists the squashfs tree')
  t.ok(stdout.includes('ARC_README'), 'decompresses a file')
  t.ok(stdout.includes('sample.AppImage&/dir'), 'prompt shows the appimage sigil')
  t.ok(stdout.includes('ARC_NESTED'), 'reads a nested file')
  t.ok(stdout.includes('kind   : appimage'))
})

test('descends into a zip on the filesystem then climbs back out', async (t) => {
  const { stdout } = await session(t, FIXTURES, ['cd archive.zip', 'cat README.md', 'up', 'pwd'])
  t.ok(stdout.includes('ARC_README'), 'mounted the zip on cd and read from it')
  t.ok(clean(stdout).includes(abbrev(FIXTURES) + '\n'), 'up climbs back to the filesystem')
})
