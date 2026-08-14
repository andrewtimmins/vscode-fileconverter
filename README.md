# FileConverter

[![CI](https://github.com/gerph/sublimetext-fileconverter/actions/workflows/ci.yml/badge.svg)](https://github.com/gerph/sublimetext-fileconverter/actions/workflows/ci.yml)

A Sublime Text plugin that opens files matching a configured pattern by
running them through an external command and streaming its output into a
new read-only view, instead of loading the raw file as text.

It was written for RISC OS binary "filetypes" (files with no dot extension,
instead suffixed `,xxx`), such as disassembling a Module/Absolute/Utility
file (`,ff8`/`,ffa`/`,ffc`) with [`riscos-dumpi`](https://pypi.org/project/riscos-disassemble/)
as it's opened. The engine itself is generic — it doesn't know anything
about RISC OS — so it can be pointed at any external tool and any filename
pattern by editing settings, no code changes required.

## How it works

When a file matching one of the configured patterns is opened, its stdout
is streamed (as it's produced — useful for slow tools, or tools whose
output would otherwise not appear until they finish) into a brand new,
detached scratch view. The view is never associated with the original
file's path, so there is no risk of accidentally saving the decoded output
back over the source file.

Some tools support the reverse direction too — turning an edited text
representation back into the original binary format. Where a handler
defines an `encode_cmd`, the decoded view stays editable (rather than being
locked read-only, which is what happens for formats with no reverse
direction) and the "FileConverter: Encode Buffer" command runs the encoder
and offers to save the result as a new file or overwrite the original
(with confirmation).

## Configuration

Handlers are defined in `FileConverter.sublime-settings`, as a list under
`"handlers"`. Each entry:

```jsonc
{
    "id": "riscos_module",
    // Regexes tested against the full file path (re.search).
    "match": [
        ".*(\\\\|/)*,ff8$",
        ".*(\\\\|/)*,ffa$",
        ".*(\\\\|/)*,ffc$"
    ],
    // Argv list; "${file}" is substituted with the source file's basename.
    // Commands resolve via PATH by default -- use an absolute path here
    // if you need to pin a specific executable. Commands are run with cwd
    // set to the file's own directory and "${file}" as a bare basename
    // (not an absolute path) -- some external tools (verified with a
    // Docker-wrapped riscos-mkdrawf) only resolve paths correctly relative
    // to the working directory.
    "decode_cmd": ["riscos-dumpi", "${file}"],
    // Most decode commands write their result to stdout (the default).
    // Some tools (eg riscos-ccres) have no stdout mode at all and always
    // write to a file -- set "decode_mode": "file" for those, and include
    // "${output}" in decode_cmd for the (relative) output filename the
    // plugin generates; its content is read back once the command exits.
    // This isn't a true incremental stream (the tool doesn't offer one):
    // the whole result appears at once. If the tool happens to accept
    // "/dev/stdout" as a plain output-file argument, prefer that instead
    // (as the riscos_ccres handler in the shipped settings does) to get
    // real streaming via the default "stdout" mode.
    "decode_mode": "stdout",
    // Optional syntax to apply to the decoded view.
    "output_syntax": "Packages/ARM Assembly/Syntaxes/ARM Assembly.tmLanguage",
    // Optional reverse-direction command (argv list). "${input}" is
    // substituted with the basename of a temp file holding the buffer's
    // text; "${output}" with the desired output's basename. Both are run
    // with cwd set to the destination directory, and the command is
    // expected to write the result directly to "${output}" (plus
    // "encode_output_suffix" below, if set) rather than to stdout. Omit
    // both keys/leave "encode_cmd" null if the format isn't reversible.
    "encode_cmd": null,
    // If the encode command always appends a fixed suffix to whatever
    // output name it's given (eg riscos-mkdrawf always appends ",aff"),
    // set it here: the plugin strips it from "${output}" before invoking
    // so the final result, once renamed into place, matches the chosen
    // destination exactly.
    "encode_output_suffix": "",
    // Optional environment variables for this handler's subprocess, merged
    // over the top-level "env" setting, merged over the process environment.
    "env": {}
}
```

Commands are run directly (`shell=False`, argv list) — no shell
interpolation of any path.

## Commands

* **FileConverter: Decode File** — manually decode the active view's file
  (or a file/folder selected in the sidebar), even if it isn't already
  open.
* **FileConverter: Encode Buffer** — available on a decoded view whose
  handler defines `encode_cmd`; encodes the current buffer and offers to
  save it as a new file or overwrite the original. Also added, greyed out
  when not applicable (including when the decode itself failed, since
  there'd be nothing sensible to re-encode), as **Re-encode As…** to both
  the **File** menu and the editor's right-click context menu.
* **FileConverter: Reveal Source File** / **Copy Source Path** — available
  on any decoded view; act on the original source file's path (stashed at
  decode time), since the decoded view itself has no `file_name()` of its
  own for Sublime's built-in "Reveal in Finder"/"Copy File Path" to act on.
  Also in the editor's right-click context menu on decoded views.

## Known limitations

* Decoded output is treated as UTF-8 (with lossy `errors='replace'`
  decoding). Tools whose output includes non-UTF-8 bytes (eg RISC OS's
  native 8-bit encoding for characters like `×` in `riscos-decdrawf`'s
  output) will show/round-trip those specific bytes as replacement
  characters rather than exactly.

## Install manually

* Clone or copy this directory into the Sublime Text `Packages` folder
  (`Preferences | Browse Packages...`) as `FileConverter`.
* Restart Sublime Text.

## Development / testing

The plugin logic can be exercised outside Sublime Text: `tests/conftest.py`
stubs the `sublime`/`sublime_plugin` modules well enough to import
`FileConverter.py` and drive its commands directly, so the test suite runs
anywhere with Python and doesn't depend on any RISC OS tooling (the
subprocess-integration tests use ordinary Unix tools like `printf`/`cp`
standing in for the shape of a real handler, not the real ones).

```
pip install pytest
python -m pytest tests/ -v
```

CI (`.github/workflows/ci.yml`) runs this on every push/PR, byte-compiles
`FileConverter.py`, and includes a check that the source has no f-strings,
since Sublime Text 3's bundled Python 3.3 doesn't support them.

## License

This package is licensed under the MIT License.
