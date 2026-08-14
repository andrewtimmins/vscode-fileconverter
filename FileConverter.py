"""Open files matching a configured pattern by streaming them through an
external command instead of loading the raw file as text.

See FileConverter.sublime-settings for the handler table.
"""

import codecs
import os
import re
import subprocess
import threading
import uuid

import sublime
import sublime_plugin


SETTINGS_FILE = 'FileConverter.sublime-settings'

_compiled_handlers = None


def _get_settings():
    return sublime.load_settings(SETTINGS_FILE)


def _reload_handlers():
    global _compiled_handlers
    _compiled_handlers = None


def plugin_loaded():
    _get_settings().add_on_change('file_converter_reload', _reload_handlers)


def plugin_unloaded():
    _get_settings().clear_on_change('file_converter_reload')


def _compile_handlers(settings):
    handlers = []
    for h in settings.get('handlers', []):
        patterns = [re.compile(p) for p in h.get('match', [])]
        handlers.append({
            'id': h.get('id', ''),
            'patterns': patterns,
            'decode_cmd': h.get('decode_cmd'),
            'decode_mode': h.get('decode_mode') or 'stdout',
            'output_syntax': h.get('output_syntax'),
            'encode_cmd': h.get('encode_cmd'),
            'encode_output_suffix': h.get('encode_output_suffix') or '',
            'env': h.get('env') or {},
        })
    return handlers


def _handlers():
    global _compiled_handlers
    if _compiled_handlers is None:
        _compiled_handlers = _compile_handlers(_get_settings())
    return _compiled_handlers


def find_handler(path):
    if not path:
        return None
    for handler in _handlers():
        for pattern in handler['patterns']:
            if pattern.search(path):
                return handler
    return None


def find_handler_by_id(handler_id):
    if not handler_id:
        return None
    for handler in _handlers():
        if handler['id'] == handler_id:
            return handler
    return None


def _view_source_path(view):
    return view.settings().get('file_converter_source_path')


def _build_argv(cmd_template, substitutions):
    """substitutions maps a literal placeholder token (e.g. '${file}') to
    its replacement value; tokens not present in cmd_template are ignored."""
    argv = []
    for arg in cmd_template:
        argv.append(substitutions.get(arg, arg))
    return argv


def _build_env(handler):
    env = os.environ.copy()
    for key, value in (_get_settings().get('env') or {}).items():
        env[key] = value
    for key, value in (handler.get('env') or {}).items():
        env[key] = value
    return env


class DecodeProcess(object):
    """Runs a decode command, streaming stdout to a callback as it arrives.

    on_data(text) is called from a background thread for each chunk of
    decoded output (view.run_command is safe to call off the main thread).
    on_done(exit_code, stderr_text) is called on the main thread once the
    process exits; exit_code is None if the process could not be launched
    at all, in which case stderr_text holds the launch error message.
    """

    def __init__(self, argv, env, cwd, on_data, on_done):
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.on_data = on_data
        self.on_done = on_done
        self.proc = None

    def start(self):
        thread = threading.Thread(target=self._run)
        thread.daemon = True
        thread.start()

    def _run(self):
        try:
            self.proc = subprocess.Popen(
                self.argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                cwd=self.cwd,
                env=self.env,
            )
        except OSError as e:
            sublime.set_timeout(lambda: self.on_done(None, str(e)), 0)
            return

        stderr_chunks = []
        stderr_thread = threading.Thread(target=self._drain_stderr, args=(stderr_chunks,))
        stderr_thread.daemon = True
        stderr_thread.start()

        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        while True:
            chunk = self.proc.stdout.read(4096)
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                self.on_data(text)
        tail = decoder.decode(b'', final=True)
        if tail:
            self.on_data(tail)

        exit_code = self.proc.wait()
        stderr_thread.join()
        stderr_text = b''.join(stderr_chunks).decode('utf-8', 'replace')
        sublime.set_timeout(lambda: self.on_done(exit_code, stderr_text), 0)

    def _drain_stderr(self, stderr_chunks):
        while True:
            chunk = self.proc.stderr.read(4096)
            if not chunk:
                break
            stderr_chunks.append(chunk)


class FileDecodeProcess(object):
    """Runs a decode command that writes its result to an output *file*
    rather than stdout -- eg riscos-ccres, which has no stdout mode at all.
    Not a true incremental stream (the tool doesn't support one): the whole
    output file is read and delivered via a single on_data() call once the
    command finishes. Follows the same on_data/on_done contract as
    DecodeProcess so callers don't need to care which one they got.
    """

    def __init__(self, argv, env, cwd, output_path, on_data, on_done):
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.output_path = output_path
        self.on_data = on_data
        self.on_done = on_done

    def start(self):
        thread = threading.Thread(target=self._run)
        thread.daemon = True
        thread.start()

    def _run(self):
        try:
            proc = subprocess.Popen(
                self.argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                cwd=self.cwd,
                env=self.env,
            )
            _out, err = proc.communicate()
        except OSError as e:
            sublime.set_timeout(lambda: self.on_done(None, str(e)), 0)
            return

        exit_code = proc.returncode
        stderr_text = err.decode('utf-8', 'replace')

        if exit_code == 0:
            try:
                with open(self.output_path, 'rb') as f:
                    text = f.read().decode('utf-8', 'replace')
                if text:
                    self.on_data(text)
            except IOError as e:
                exit_code = -1
                stderr_text = 'command exited successfully but output could not be read: {0}'.format(e)
            finally:
                if os.path.exists(self.output_path):
                    os.remove(self.output_path)

        sublime.set_timeout(lambda: self.on_done(exit_code, stderr_text), 0)


def run_decode(window, source_path, handler, source_view=None):
    """Shared entry point for both the auto-load trigger and the manual
    "Decode File" command: streams handler['decode_cmd']'s stdout into a
    brand-new scratch view (never associated with source_path), then marks
    it read-only. If source_view is given (the raw view Sublime auto-loaded
    before this handler intercepted it), it is closed once decoding starts.
    """
    if not handler.get('decode_cmd'):
        sublime.error_message('FileConverter: handler "{0}" has no decode command configured.'.format(
            handler.get('id', '?')))
        return

    new_view = window.new_file()
    new_view.set_scratch(True)
    new_view.set_name(os.path.basename(source_path) + ' (decoded)')
    new_view.settings().set('file_converter_source_path', source_path)
    new_view.settings().set('file_converter_handler_id', handler.get('id', ''))

    if handler.get('output_syntax'):
        try:
            new_view.assign_syntax(handler['output_syntax'])
        except Exception:
            pass

    sublime.status_message('FileConverter: decoding {0}...'.format(source_path))

    # Run with cwd set to the file's own directory and pass its bare
    # basename for "${file}", rather than an absolute path: some external
    # tools (verified with a Docker-wrapped riscos-mkdrawf) only resolve
    # paths correctly relative to the process's working directory.
    cwd = os.path.dirname(source_path) or '.'
    env = _build_env(handler)
    decode_mode = handler.get('decode_mode') or 'stdout'

    def on_data(text):
        new_view.run_command('append', {'characters': text, 'force': True, 'scroll_to_end': True})

    def on_done(exit_code, stderr_text):
        if exit_code is None:
            new_view.run_command('append', {
                'characters': '\n--- failed to launch: {0} ---\n'.format(stderr_text),
                'force': True, 'scroll_to_end': True,
            })
            sublime.error_message('FileConverter: failed to launch decode command:\n{0}'.format(stderr_text))
            new_view.settings().set('file_converter_decode_failed', True)
        elif exit_code != 0:
            new_view.run_command('append', {
                'characters': '\n--- stderr (exit {0}) ---\n{1}'.format(exit_code, stderr_text),
                'force': True, 'scroll_to_end': True,
            })
            sublime.error_message('FileConverter: decode command exited with status {0}.'.format(exit_code))
            new_view.settings().set('file_converter_decode_failed', True)
        else:
            sublime.status_message('FileConverter: decoded {0}'.format(source_path))

        if not handler.get('encode_cmd'):
            # No reverse direction for this format: lock it down, since
            # there's nothing useful to do here but read it. Formats that
            # do have an encode_cmd are left editable -- the whole point is
            # to edit the decoded text and re-encode it. Either way, this
            # view is never associated with the source file's path, so
            # there's no risk of it being saved back over the source.
            new_view.set_read_only(True)

        if source_view is not None and source_view.is_valid():
            source_view.close()

    if decode_mode == 'file':
        # This tool has no stdout mode at all (verified with riscos-ccres):
        # it always writes its result to an output file argument. Give it
        # a throwaway relative name in the same directory (same reasoning
        # as the cwd/basename choice above) and read the whole thing back
        # once it's finished.
        output_name = '.fileconverter-decode-{0}.tmp'.format(uuid.uuid4().hex)
        output_path = os.path.join(cwd, output_name)
        argv = _build_argv(handler['decode_cmd'], {
            '${file}': os.path.basename(source_path),
            '${output}': output_name,
        })
        FileDecodeProcess(argv, env, cwd, output_path, on_data, on_done).start()
    else:
        argv = _build_argv(handler['decode_cmd'], {'${file}': os.path.basename(source_path)})
        DecodeProcess(argv, env, cwd, on_data, on_done).start()


class FileConverterLoadListener(sublime_plugin.EventListener):
    def on_load_async(self, view):
        path = view.file_name()
        if not path:
            return
        handler = find_handler(path)
        if handler is None:
            return
        window = view.window()
        if window is None:
            return
        # Neutralise the raw view Sublime already loaded (garbled bytes as
        # text) before it can be edited or saved back over the source file.
        view.set_scratch(True)
        view.set_read_only(True)
        run_decode(window, path, handler, source_view=view)


class FileConverterDecodeFileCommand(sublime_plugin.WindowCommand):
    """Command Palette / sidebar entry: "FileConverter: Decode File"."""

    def run(self, paths=None):
        path = self._target_path(paths)
        if not path:
            return
        handler = find_handler(path)
        if handler is None:
            sublime.error_message('FileConverter: no handler configured for {0}'.format(path))
            return
        run_decode(self.window, path, handler)

    def is_enabled(self, paths=None):
        return find_handler(self._target_path(paths)) is not None

    is_visible = is_enabled

    def _target_path(self, paths):
        if paths:
            return paths[0]
        view = self.window.active_view()
        return view.file_name() if view else None


class FileConverterEncodeBufferCommand(sublime_plugin.TextCommand):
    """Command Palette entry: "FileConverter: Encode Buffer".

    Runs handler['encode_cmd'], substituting "${input}" with a temp file
    holding the buffer's text and "${output}" with the desired output
    basename, both relative to a working directory set to the destination
    folder -- verified against riscos-mkdrawf, which only resolves paths
    correctly relative to cwd, not given as absolute paths. If the handler
    sets "encode_output_suffix" (e.g. ",aff" for riscos-mkdrawf, which
    always appends it to whatever output name it's given, so passing
    ",aff" straight through would produce "name,aff,aff"), that suffix is
    stripped from "${output}" before invoking, and the file the command
    actually produces is renamed to match the chosen destination exactly.
    """

    def run(self, edit):
        handler = self._handler()
        if handler is None or not handler.get('encode_cmd'):
            sublime.error_message('FileConverter: no encode command configured for this view.')
            return

        source_path = self.view.settings().get('file_converter_source_path')
        text = self.view.substr(sublime.Region(0, self.view.size()))

        if source_path:
            choice = sublime.yes_no_cancel_dialog(
                'Save the encoded output as a new file, or overwrite the original ({0})?'.format(source_path),
                'Save As…', 'Overwrite Original')
            if choice == sublime.DIALOG_CANCEL:
                return
            if choice == sublime.DIALOG_NO:
                if not sublime.ok_cancel_dialog(
                        'This will replace {0}. This cannot be undone. Continue?'.format(source_path),
                        'Overwrite'):
                    return
                self._run_encode_and_write(handler, text, source_path)
                return

        directory = os.path.dirname(source_path) if source_path else None

        def on_save_path(dest_path):
            if dest_path:
                self._run_encode_and_write(handler, text, dest_path)

        sublime.save_dialog(on_save_path, directory=directory)

    def is_enabled(self):
        handler = self._handler()
        if handler is None or not handler.get('encode_cmd'):
            return False
        return not self.view.settings().get('file_converter_decode_failed', False)

    def _handler(self):
        return find_handler_by_id(self.view.settings().get('file_converter_handler_id'))

    def _run_encode_and_write(self, handler, text, dest_path):
        sublime.status_message('FileConverter: encoding...')
        env = _build_env(handler)
        encode_cmd = handler['encode_cmd']
        suffix = handler.get('encode_output_suffix') or ''

        dest_dir = os.path.dirname(dest_path) or '.'
        dest_name = os.path.basename(dest_path)
        output_arg = dest_name[:-len(suffix)] if suffix and dest_name.endswith(suffix) else dest_name
        produced_path = os.path.join(dest_dir, output_arg + suffix)
        input_name = '.fileconverter-input-{0}.tmp'.format(uuid.uuid4().hex)
        input_path = os.path.join(dest_dir, input_name)

        def worker():
            try:
                with open(input_path, 'wb') as f:
                    f.write(text.encode('utf-8'))

                argv = _build_argv(encode_cmd, {'${input}': input_name, '${output}': output_arg})
                proc = subprocess.Popen(
                    argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL, cwd=dest_dir, env=env)
                _out, err = proc.communicate()
            except OSError as e:
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: failed to launch encode command:\n{0}'.format(e)), 0)
                return
            finally:
                if os.path.exists(input_path):
                    os.remove(input_path)

            if proc.returncode != 0:
                message = err.decode('utf-8', 'replace')
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: encode command exited with status {0}:\n{1}'.format(
                        proc.returncode, message)), 0)
                return

            if not os.path.exists(produced_path):
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: encode command exited successfully but {0} was not created.'.format(
                        produced_path)), 0)
                return

            try:
                if os.path.abspath(produced_path) != os.path.abspath(dest_path):
                    os.replace(produced_path, dest_path)
            except OSError as e:
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: encoded {0} but failed to move it to {1}:\n{2}'.format(
                        produced_path, dest_path, e)), 0)
                return

            sublime.set_timeout(lambda: sublime.status_message(
                'FileConverter: wrote {0}'.format(dest_path)), 0)

        thread = threading.Thread(target=worker)
        thread.daemon = True
        thread.start()


class FileConverterRevealSourceCommand(sublime_plugin.TextCommand):
    """Reveals the source file this decoded view came from, in the system
    file manager. The decoded view has no file_name() of its own to reveal
    -- that's deliberate -- so this uses the source path stashed in the
    view's settings at decode time instead."""

    def run(self, edit):
        source_path = _view_source_path(self.view)
        if not source_path:
            return
        platform = sublime.platform()
        try:
            if platform == 'osx':
                subprocess.Popen(['open', '-R', source_path])
            elif platform == 'windows':
                subprocess.Popen(['explorer', '/select,{0}'.format(source_path)])
            else:
                subprocess.Popen(['xdg-open', os.path.dirname(source_path)])
        except OSError as e:
            sublime.error_message('FileConverter: failed to reveal {0}:\n{1}'.format(source_path, e))

    def is_enabled(self):
        return bool(_view_source_path(self.view))

    is_visible = is_enabled


class FileConverterCopySourcePathCommand(sublime_plugin.TextCommand):
    """Copies the path of the source file this decoded view came from."""

    def run(self, edit):
        source_path = _view_source_path(self.view)
        if source_path:
            sublime.set_clipboard(source_path)
            sublime.status_message('FileConverter: copied {0}'.format(source_path))

    def is_enabled(self):
        return bool(_view_source_path(self.view))

    is_visible = is_enabled
