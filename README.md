# FileConverter

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
back over the source file; it's also marked read-only once the command
finishes.

Some tools support the reverse direction too — turning an edited text
representation back into the original binary format. Where a handler
defines an `encode_cmd`, the "FileConverter: Encode Buffer" command runs it
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
    // Argv list; "${file}" is substituted with the source file's path.
    // Commands resolve via PATH by default -- use an absolute path here
    // if you need to pin a specific executable.
    "decode_cmd": ["riscos-dumpi", "${file}"],
    // Optional syntax to apply to the decoded view.
    "output_syntax": "Packages/ARM Assembly/Syntaxes/ARM Assembly.tmLanguage",
    // Optional reverse-direction command (argv list, same "${file}"
    // substitution, applied to a temp file holding the buffer's text;
    // its stdout is written to the destination). Omit/null if the format
    // isn't reversible.
    "encode_cmd": null,
    // Optional environment variables for this handler's subprocess, merged
    // over the top-level "env" setting, merged over the process environment.
    "env": {}
}
```

Commands are run directly (`shell=False`, argv list) — no shell
interpolation of the file path.

## Commands

* **FileConverter: Decode File** — manually decode the active view's file
  (or a file/folder selected in the sidebar), even if it isn't already
  open.
* **FileConverter: Encode Buffer** — available on a decoded view whose
  handler defines `encode_cmd`; encodes the current buffer and offers to
  save it as a new file or overwrite the original.

## Install manually

* Clone or copy this directory into the Sublime Text `Packages` folder
  (`Preferences | Browse Packages...`) as `FileConverter`.
* Restart Sublime Text.

## License

This package is licensed under the MIT License.
