"""Stubs Sublime Text's `sublime`/`sublime_plugin` modules so FileConverter.py
can be imported and exercised outside the editor, in plain CI."""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class FakeSettings(object):
    def __init__(self, data=None):
        self._data = data or {}
        self._callbacks = {}

    def get(self, key, default=None):
        return self._data.get(key, default)

    def set(self, key, value):
        self._data[key] = value

    def add_on_change(self, tag, callback):
        self._callbacks[tag] = callback

    def clear_on_change(self, tag):
        self._callbacks.pop(tag, None)


class FakeRegion(object):
    def __init__(self, a, b=None):
        self.a = a
        self.b = a if b is None else b


class FakeView(object):
    def __init__(self, file_name=None):
        self._file_name = file_name
        self._settings = FakeSettings()
        self.appended = []
        self.read_only = False
        self.scratch = False
        self.name = None
        self.syntax = None
        self.closed = False
        self.content = ''

    def file_name(self):
        return self._file_name

    def settings(self):
        return self._settings

    def set_scratch(self, value):
        self.scratch = value

    def set_name(self, name):
        self.name = name

    def assign_syntax(self, syntax):
        self.syntax = syntax

    def set_read_only(self, value):
        self.read_only = value

    def is_valid(self):
        return not self.closed

    def is_dirty(self):
        return False

    def close(self):
        self.closed = True

    def size(self):
        return len(self.content)

    def substr(self, region):
        return self.content[region.a:region.b]

    def window(self):
        return None

    def run_command(self, name, args=None):
        args = args or {}
        if name == 'append':
            self.content += args.get('characters', '')
            self.appended.append(args.get('characters', ''))


class FakeWindow(object):
    def __init__(self):
        self.created_views = []

    def new_file(self):
        view = FakeView()
        self.created_views.append(view)
        return view


def install_stub_sublime_modules():
    sublime = types.ModuleType('sublime')
    sublime.DIALOG_YES = 1
    sublime.DIALOG_NO = 0
    sublime.DIALOG_CANCEL = -1
    sublime.Region = FakeRegion
    sublime.set_timeout = lambda fn, delay=0: fn()
    sublime.set_timeout_async = lambda fn, delay=0: fn()
    sublime.status_message = lambda msg: None
    sublime.error_message = lambda msg: None
    sublime.set_clipboard = lambda text: None
    sublime.platform = lambda: 'osx'
    sublime.load_settings = lambda name: FakeSettings()
    sublime.save_dialog = lambda callback, directory=None, **kw: None
    sublime.yes_no_cancel_dialog = lambda *a, **kw: sublime.DIALOG_CANCEL
    sublime.ok_cancel_dialog = lambda *a, **kw: False
    sys.modules['sublime'] = sublime

    sublime_plugin = types.ModuleType('sublime_plugin')

    class EventListener(object):
        pass

    class WindowCommand(object):
        pass

    class TextCommand(object):
        pass

    sublime_plugin.EventListener = EventListener
    sublime_plugin.WindowCommand = WindowCommand
    sublime_plugin.TextCommand = TextCommand
    sys.modules['sublime_plugin'] = sublime_plugin

    return sublime, sublime_plugin


install_stub_sublime_modules()
