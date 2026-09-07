const ReadyResource = require('ready-resource')
const readline = require('bare-readline')

class Repl extends ReadyResource {
  constructor({ input = process.stdin, output = process.stdout, prompt = '> ', banner } = {}) {
    super()
    this.command = null
    this.prompting = false
    this.io = { input, output, prompt, banner, rl: null }
  }

  _initReadline() {
    if (this.io.rl) return this.io.rl

    if (this.io.input.isTTY) {
      this.io.input.setRawMode(true)
      this.io.input.resume()
    }

    this.io.rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      prompt: this.io.prompt
    })

    return this.io.rl
  }

  async _open() {
    if (!this.command) throw new Error('Repl subclass must set this.command')

    this._initReadline()

    if (typeof this.completer === 'function') {
      const decoder = this.io.rl._decoder
      const onkey = this.io.rl._onkey

      decoder.removeListener('data', onkey)

      decoder.on('data', (key) => {
        if (key.name === 'tab' || key.sequence === '\t') {
          this.completer.call(this, this.io.rl)
          return
        }

        onkey.call(this.io.rl, key)
      })
    }

    let closed = false

    this.io.rl.on('close', () => {
      closed = true
      this.prompting = false

      if (this.io.input.isTTY) {
        this.io.input.setRawMode(false)
      }
    })

    const prompt = () => {
      if (closed) return
      this.prompting = true
      this.io.rl.prompt()
    }

    if (this.io.banner) this.io.output.write(this.io.banner + '\n')

    prompt()

    for await (const line of this.io.rl) {
      this.prompting = false
      const trimmed = line.trim()

      if (!trimmed) {
        prompt()
        continue
      }

      if (trimmed === 'exit' || trimmed === 'quit') break

      const argv = tokenize(trimmed)

      if (argv[0] === 'help' && argv.length === 1) {
        this.io.output.write(this.command.help() + '\n')
        prompt()
        continue
      }

      try {
        const parsed = this.command.parse(argv, { silent: false })

        if (parsed && parsed.running) {
          await parsed.running
        }
      } catch (err) {
        this.io.output.write(`error: ${err.message}\n`)
      }

      prompt()
    }
  }

  _close() {
    if (this.io.rl) this.io.rl.close()
  }
}

function tokenize(line) {
  const out = []
  let buf = ''
  let inSingle = false
  let inDouble = false

  for (const ch of line) {
    if (inSingle) {
      if (ch === "'") {
        inSingle = false
        continue
      }

      buf += ch
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false
        continue
      }

      buf += ch
    } else if (ch === "'") {
      inSingle = true
    } else if (ch === '"') {
      inDouble = true
    } else if (/\s/.test(ch)) {
      if (buf.length) {
        out.push(buf)
        buf = ''
      }
    } else {
      buf += ch
    }
  }

  if (buf.length) out.push(buf)

  return out
}

module.exports = Repl
