const extract = require('bare-standalone-bundle-extract')
const BundleDrive = require('./bundle-drive')

module.exports = class BinaryDrive extends BundleDrive {
  static fromBytes(bytes) {
    const embedded = this.embedded(bytes)
    return embedded ? new BundleDrive(embedded) : null
  }

  static embedded(bytes) {
    if (!isBin(bytes)) return null
    return extract(bytes)
  }

  constructor(bytes) {
    const embedded = isBin(bytes) ? extract(bytes) : null
    if (embedded === null) throw new Error('Invalid Binary')
    super(embedded)
  }
}

// ELF (7f 45 4c 46), PE ("MZ"), or Mach-O (thin/fat) magic.
function isBin(bytes) {
  const MACHO = new Set([
    0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca
  ])
  if (bytes.length < 4) return false
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true
  const magic = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return magic === 0x7f454c46 || MACHO.has(magic)
}
