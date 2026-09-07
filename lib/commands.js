// bare-rpc command numbers for the main <-> worker protocol.
module.exports = {
  INIT: 1, // main -> worker: { storage, updates, version, upgrade, name, app }
  OPEN: 2, // main -> worker: { link, timeout } -> { handle, kind, prefix, label, meta }
  ENTRY: 3, // main -> worker: { handle, key } -> { entry }
  GET: 4, // main -> worker: { handle, key } -> raw bytes (empty = null)
  LIST: 5, // main -> worker: { handle, folder } -> [entry, ...]
  CLOSE: 6, // main -> worker: { handle }
  UPDATE: 7, // worker -> main: { event, message } — OTA update lifecycle notification
  VERSION: 8 // main -> worker: {} -> { version, link }
}
