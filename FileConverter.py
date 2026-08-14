"""Open files matching a configured pattern by streaming them through an
external command instead of loading the raw file as text.

See FileConverter.sublime-settings for the handler table.
"""

import codecs
import os
import re
import subprocess
import tempfile
import threading

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
            'output_syntax': h.get('output_syntax'),
            'encode_cmd': h.get('encode_cmd'),
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


def _build_argv(cmd_template, file_path):
    argv = []
    for arg in cmd_template:
        argv.append(file_path if arg == '${file}' else arg)
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

    def __init__(self, argv, env, on_data, on_done):
        self.argv = argv
        self.env = env
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

    argv = _build_argv(handler['decode_cmd'], source_path)
    env = _build_env(handler)

    def on_data(text):
        new_view.run_command('append', {'characters': text, 'force': True, 'scroll_to_end': True})

    def on_done(exit_code, stderr_text):
        if exit_code is None:
            new_view.run_command('append', {
                'characters': '\n--- failed to launch: {0} ---\n'.format(stderr_text),
                'force': True, 'scroll_to_end': True,
            })
            sublime.error_message('FileConverter: failed to launch decode command:\n{0}'.format(stderr_text))
        elif exit_code != 0:
            new_view.run_command('append', {
                'characters': '\n--- stderr (exit {0}) ---\n{1}'.format(exit_code, stderr_text),
                'force': True, 'scroll_to_end': True,
            })
            sublime.error_message('FileConverter: decode command exited with status {0}.'.format(exit_code))
        else:
            sublime.status_message('FileConverter: decoded {0}'.format(source_path))

        new_view.set_read_only(True)

        if source_view is not None and source_view.is_valid():
            source_view.close()

    DecodeProcess(argv, env, on_data, on_done).start()


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

    UNVERIFIED: assumes the encode command takes its input as a file
    argument (the buffer's text written to a temp file, substituted for
    "${file}") and writes the encoded binary to stdout, mirroring
    decode_cmd's shape. Adjust _run_encode_and_write() once the real tool's
    CLI (e.g. riscos-mkdrawf) is confirmed -- everything else in this
    command (dialogs, destination handling) is independent of that detail.
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
        return handler is not None and bool(handler.get('encode_cmd'))

    def _handler(self):
        return find_handler_by_id(self.view.settings().get('file_converter_handler_id'))

    def _run_encode_and_write(self, handler, text, dest_path):
        sublime.status_message('FileConverter: encoding...')
        env = _build_env(handler)
        encode_cmd = handler['encode_cmd']

        def worker():
            tmp_path = None
            try:
                fd, tmp_path = tempfile.mkstemp(suffix='.fileconverter-src')
                with os.fdopen(fd, 'wb') as f:
                    f.write(text.encode('utf-8'))

                argv = _build_argv(encode_cmd, tmp_path)
                proc = subprocess.Popen(
                    argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL, env=env)
                out, err = proc.communicate()
            except OSError as e:
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: failed to launch encode command:\n{0}'.format(e)), 0)
                return
            finally:
                if tmp_path and os.path.exists(tmp_path):
                    os.remove(tmp_path)

            if proc.returncode != 0:
                message = err.decode('utf-8', 'replace')
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: encode command exited with status {0}:\n{1}'.format(
                        proc.returncode, message)), 0)
                return

            try:
                with open(dest_path, 'wb') as f:
                    f.write(out)
            except IOError as e:
                sublime.set_timeout(lambda: sublime.error_message(
                    'FileConverter: failed to write {0}:\n{1}'.format(dest_path, e)), 0)
                return

            sublime.set_timeout(lambda: sublime.status_message(
                'FileConverter: wrote {0}'.format(dest_path)), 0)

        thread = threading.Thread(target=worker)
        thread.daemon = True
        thread.start()
