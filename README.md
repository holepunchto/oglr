# oglr

> Look inside Pear Applications

## Install

With [Pear CLI](https://install.pears.com):

```
pear install pear://o3c9afa5rw7sep5bd3xo796w1gz9f9u7oxg356dc3om958cs84gy
```

Or bootstrap via `npm`:

```
npm init oglr
```

Either way `oglr` is installed to `~/.local/bin/oglr` on macOS & Linux or `%LOCALAPPDATA%\Programs\oglr\oglr.exe` on Windows.

## Usage

```
oglr [source] [subcommand]
```

`source` is a directory (`.`, `./x`, `/abs`), a `file://` URL, or a `pear://` link. With no subcommand opens a interactive REPL (read-eval-print-loop), with subcommand runs once and exits:

```
oglr pear://<key>            # browse a hyperdrive interactively
oglr ./app.bundle ls         # one-shot: list the bundle's root
oglr ./release.AppImage      # browse an AppImage
```

### Commands

| command                        | what                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `ls [path]`                    | list a directory                                                                 |
| `cd <path>`                    | enter a directory, or descend into a container file                              |
| `cat [path]`                   | print a file (binary is detected, large output truncated)                        |
| `tree [path]`                  | recursive listing                                                                |
| `size [path]`                  | file size, or total bytes / file count of a directory                            |
| `info [path]`                  | container kind, id/main/addons, file count                                       |
| `version`                      | running semver and the live `pear://<fork>.<length>.<key>` link                  |
| `mirror <to> [from] [--force]` | copy a subtree to a local directory (refuses a non-empty `to` without `--force`) |
| `up`                           | climb back out to the parent container                                           |
| `pwd` · `help` · `exit`        |                                                                                  |

### Container formats

The prompt shows a single-char sigil for the container you're currently inside:

| sigil | format              |
| ----- | ------------------- |
| `@`   | pear:// hyperdrive  |
| `#`   | bare bundle         |
| `%`   | standalone binary   |
| `=`   | msix                |
| `+`   | tar / tar.gz        |
| `&`   | AppImage (squashfs) |

A plain filesystem path is shown as-is (abbreviated under `~`).

### Flags

- `--storage <dir>` — storage directory (defaults to a per-app location; pass this to run a second instance).
- `--no-updates` — disable OTA updates.
- `--version` — print the version and upgrade link, then exit (no source or storage needed).

## Develop

```
npm test        # brittle, end-to-end through the CLI
npm run lint
npm run make    # standalone builds into ./out
```

## License

Apache-2.0
