# FileConverter

[![CI](https://github.com/andrewtimmins/vscode-fileconverter/actions/workflows/ci.yml/badge.svg)](https://github.com/andrewtimmins/vscode-fileconverter/actions/workflows/ci.yml)

A Visual Studio Code extension that opens files matching a configured pattern
by running them through an external command and streaming its output into a
new read-only document, instead of loading the raw file as text.

It was written for RISC OS binary "filetypes" (files with no dot extension,
instead suffixed `,xxx`), such as disassembling a Module/Absolute/Utility
file (`,ff8`/`,ffa`/`,ffc`) with [`riscos-dumpi`](https://pypi.org/project/riscos-disassemble/)
as it is opened. The engine itself is generic. It doesn't know anything about
RISC OS, so it can be pointed at any external tool and any filename pattern
by editing settings, with no code changes required.

## Credits

FileConverter was created by **[Charles Ferguson (gerph)](https://github.com/gerph)**
as a Sublime Text plugin: [gerph/sublimetext-fileconverter](https://github.com/gerph/sublimetext-fileconverter).
The design, the handler model, and all of the work of getting the RISC OS
tooling to behave are his.

This repository is a port of that plugin to Visual Studio Code by
[Andrew Timmins](https://github.com/andrewtimmins). It is a rewrite of the
host integration only: the Sublime Text plugin API has no VS Code equivalent,
so the editor-facing layer is new, whilst the conversion engine and the
handler configuration follow the original closely enough that settings port
across almost unchanged (see [Differences from the Sublime Text original](#differences-from-the-sublime-text-original)).

Released under the MIT Licence, retaining the original copyright. See
[LICENSE](LICENSE).

**Platform support: macOS and Linux only.** Every shipped handler depends on
Unix tooling (the RISC OS handlers on a Docker-based toolchain built for Unix
hosts; the generic examples on `xxd`/`objdump`/`exiftool`), and the
`riscos_ccres` handler's decode command relies on `/dev/stdout`. None of that
has a built-in Windows equivalent, so this isn't tested or supported there.

## How it works

When a file matching one of the configured patterns is opened, the raw editor
VS Code opened for it is closed before it can be edited, and the decode
command's stdout is streamed into a brand new document under a private
`fileconverter:` URI scheme. Output appears as it is produced, which is useful
for slow tools, or tools whose output would otherwise not appear until they
finish.

That document is never associated with the original file's path, so there is
no risk of accidentally saving the decoded output back over the source file.

Some tools support the reverse direction too, turning an edited text
representation back into the original binary format. Where a handler defines
an `encode_cmd`, the decoded document stays editable, and the
**FileConverter: Re-encode As…** command runs the encoder and offers to save
the result as a new file or overwrite the original (with confirmation). Where
a handler has no `encode_cmd`, there is nothing useful to do but read the
output, so the document is opened read-only.

## Configuration

Handlers live in your VS Code settings under `fileconverter.handlers`. The
setting ships with the handlers below already configured; edit it in
`settings.json`, or run **FileConverter: Open Settings**.

```jsonc
{
  "id": "riscos_module",
  // Regexes tested against the full file path, unanchored.
  "match": [
    ".*(\\\\|/)*,ff8$",
    ".*(\\\\|/)*,ffa$",
    ".*(\\\\|/)*,ffc$"
  ],
  // Argv list; "${file}" is substituted with the source file's basename.
  // Commands resolve via PATH by default. Use an absolute path here if you
  // need to pin a specific executable. Commands run with the working
  // directory set to the file's own directory and "${file}" as a bare
  // basename rather than an absolute path, because some external tools
  // (verified with a Docker-wrapped riscos-mkdrawf) only resolve paths
  // correctly relative to the working directory.
  "decode_cmd": ["riscos-dumpi", "${file}"],
  // Most decode commands write their result to stdout (the default). Some
  // tools (eg riscos-ccres) have no stdout mode at all and always write to
  // a file. Set "decode_mode": "file" for those, and include "${output}"
  // in decode_cmd for the relative output filename the extension generates;
  // its content is read back once the command exits. This isn't a true
  // incremental stream, because the tool doesn't offer one: the whole
  // result appears at once. If the tool happens to accept "/dev/stdout" as
  // a plain output-file argument, prefer that instead (as the riscos_ccres
  // handler does) to get real streaming via the default "stdout" mode.
  "decode_mode": "stdout",
  // Optional VS Code language identifier for syntax highlighting. Ignored
  // if no installed extension provides that language.
  "language": "arm",
  // Optional reverse-direction command (argv list). "${input}" is
  // substituted with the basename of a temporary file holding the
  // document's text; "${output}" with the desired output's basename. Both
  // run with the working directory set to the destination directory, and
  // the command is expected to write the result directly to "${output}"
  // (plus "encode_output_suffix" below, if set) rather than to stdout.
  // Leave "encode_cmd" null if the format isn't reversible.
  "encode_cmd": null,
  // If the encode command always appends a fixed suffix to whatever output
  // name it is given (eg riscos-mkdrawf always appends ",aff"), set it
  // here. The extension strips it from "${output}" before invoking, so the
  // final result, once renamed into place, matches the chosen destination
  // exactly.
  "encode_output_suffix": "",
  // Optional environment variables for this handler's subprocesses, merged
  // over the "fileconverter.env" setting, merged over the environment VS
  // Code itself was launched with.
  "env": {}
}
```

Commands are run directly as an argv list, with no shell, so no path is ever
subject to shell interpolation.

### RISC OS handlers

All verified against the real tools by the original author, including a
decode, edit, encode, decode round trip for the reversible ones:

* **riscos_module** (`,ff8`/`,ffa`/`,ffc`): Module/Absolute/Utility binaries
  disassembled with `riscos-dumpi`. One-way.
* **riscos_drawfile** (`,aff`): Draw files, via `riscos-decdrawf` and
  `riscos-mkdrawf`. `riscos-mkdrawf` always appends `,aff` to whatever output
  name it is given, hence `encode_output_suffix`.
* **riscos_ccres** (`,fec` Wimp Template, `,fae` Toolbox Resource): one tool,
  `riscos-ccres`, auto-detects both the source filetype and the decode/encode
  direction from content, so it covers both formats.
* **riscos_basic** (`,ffb`): tokenised BBC BASIC, via `riscos-basicdetokenise`
  and `riscos-basictokenise`. Unlike the other tools,
  `riscos-basicdetokenise` takes its input via `-i` rather than a bare
  positional argument.

### Beyond RISC OS

The engine doesn't know anything about RISC OS. The RISC OS handlers just
happen to be the ones this was originally built for. Anything that turns a
binary into descriptive text fits the same shape, and three non-RISC-OS
examples ship enabled by default so the extension is useful from the first
install:

* **hexdump**: any `.bin` file through `xxd`.
* **objdump**: any `.o` file through `objdump -d`. No `language` is set by
  default, since objdump's output is AT&T-flavoured on some platforms and
  Intel-flavoured on others. Point it at whatever assembly language extension
  you have installed, if any, and prefer it.
* **exif**: `.jpg`/`.jpeg`/`.png`/`.heic` metadata through `exiftool`.

All three are one-way (no `encode_cmd`). Because `.bin`, `.o`, `.jpg` and
`.png` are far more common extensions than the RISC OS comma-suffixes, these
*will* intercept any matching file you open, anywhere. Delete or narrow their
`match` entries in your own settings (eg to a specific directory) if that
isn't what you want, or if you don't have `xxd`, `objdump` or `exiftool`
installed and would rather they didn't error on open.

## Commands

* **FileConverter: Decode File**: manually decode the active editor's file, or
  a file selected in the Explorer, even if it isn't already open.
* **FileConverter: Re-encode As…**: available on a decoded document whose
  handler defines `encode_cmd`. Encodes the current document and offers to
  save it as a new file or overwrite the original. Hidden when not applicable,
  including when the decode itself failed, since there would be nothing
  sensible to re-encode.
* **FileConverter: Reveal Source File** and **Copy Source Path**: available on
  any decoded document. Both act on the original source file's path, recorded
  at decode time, because the decoded document has no path of its own for the
  built-in "Reveal in File Explorer" and "Copy Path" to act on.
* **FileConverter: Open Settings**: jumps to this extension's settings.

The last three also appear in the editor's right-click menu on decoded
documents, and **Decode File** appears in the Explorer's right-click menu.

## Differences from the Sublime Text original

Behaviour is intentionally the same wherever the two editors allow it. Where
they differ:

* **Settings location.** Handlers move from `FileConverter.sublime-settings`
  to `fileconverter.handlers` in VS Code's settings. The handler keys
  themselves are unchanged, so an existing handler list can be pasted across
  as-is, with one exception below.
* **`output_syntax` becomes `language`.** Sublime takes a path to a
  `.sublime-syntax` file; VS Code takes a language identifier such as `arm`.
  An identifier no installed extension provides is ignored, and the document
  is left as plain text, rather than being treated as an error.
* **Read-only is enforced differently.** Sublime marks the view read-only
  directly. Here the decoded document is served from a virtual file system
  under the `fileconverter:` scheme, which reports the file as read-only to
  VS Code. The practical effect is the same, and the decoded document still
  has no association with the source file's path.
* **No jump to the top when decoding finishes.** Sublime scrolled to the end
  as content was appended, so it had to correct itself once the decode
  completed. Here the viewport is left where you put it, so a long decode you
  have scrolled into stays where you were reading.
* **Streaming is republished in batches**, at most every 150ms, rather than
  appended character by character. Output still appears as the command
  produces it.
* **Closing a decoded document cancels a decode still running for it**, which
  the original had no equivalent of.
* **Revealing the source file** uses VS Code's built-in reveal command
  instead of shelling out to `open`, `explorer` or `xdg-open`.

## Known limitations

* Decoded output is treated as UTF-8, decoded leniently. Tools whose output
  includes non-UTF-8 bytes (eg RISC OS's native 8-bit encoding for characters
  such as `×` in `riscos-decdrawf`'s output) will show and round-trip those
  specific bytes as replacement characters rather than exactly.
* Interception happens just after VS Code opens the file, so a matching file
  may flash briefly in a raw editor before being replaced by the decoded one.
  VS Code offers no way to claim a file pattern ahead of the text editor
  without replacing it with a webview, which would cost the find, selection
  and syntax highlighting that make the decoded output worth reading.

## Install

No Marketplace release yet. To build and install the extension locally:

```
npm install
npx @vscode/vsce package
code --install-extension fileconverter-*.vsix
```

## Development

The conversion engine (`src/handlers.ts`, `src/decode.ts`, `src/encode.ts`)
is deliberately free of any `vscode` import, so it can be exercised in plain
Node without an extension host. That is the same reasoning behind the
original's stubbed `sublime` module, and a test enforces it. The test suite
therefore runs anywhere with Node and doesn't depend on any RISC OS tooling:
the subprocess integration tests use ordinary Unix tools such as `printf` and
`cp`, standing in for the shape of a real handler rather than the real thing.

```
npm install
npm test
```

The parts that can only work inside the editor (intercepting the open, the
virtual file system, read-only enforcement) are covered separately, by a suite
that downloads a VS Code build and runs against a real extension host:

```
npm run test:integration
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
the extension loaded.

CI (`.github/workflows/ci.yml`) runs both suites on every push and pull
request, and builds the `.vsix` package as an artefact.

## Licence

MIT. See [LICENSE](LICENSE), which retains Charles Ferguson's original
copyright.
