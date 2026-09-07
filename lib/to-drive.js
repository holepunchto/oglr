const BundleDrive = require('./bundle-drive')
const BinaryDrive = require('./binary-drive')
const MsixDrive = require('./msix-drive')
const TarDrive = require('./tar-drive')
const AppImageDrive = require('./appimage-drive')

function toDrive(bytes) {
  return (
    AppImageDrive.fromBytes(bytes) ||
    BinaryDrive.fromBytes(bytes) ||
    MsixDrive.fromBytes(bytes) ||
    TarDrive.fromBytes(bytes) ||
    BundleDrive.fromBytes(bytes)
  )
}

module.exports = toDrive
