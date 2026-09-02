const plink = require('pear-link')

// pear-link parses a bare-key link with fork and length null, and serialize()
// drops nullish parts — so default them to 0, the way pear-runtime-updater does
// when it derives its own link from the upgrade key.
function serialize({ fork, length, key }) {
  return plink.serialize({ drive: { fork: fork || 0, length: length || 0, key } })
}

// Normalise an existing link to the full pear://<fork>.<length>.<key> shape.
function fromLink(link) {
  return serialize(plink.parse(link).drive)
}

module.exports = { serialize, fromLink }
