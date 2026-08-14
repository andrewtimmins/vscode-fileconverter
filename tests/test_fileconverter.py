import ast
import json
import os
import re
import time

import pytest

import FileConverter as fc
from conftest import FakeSettings, FakeView, FakeWindow

REPO_ROOT = os.path.join(os.path.dirname(__file__), '..')


@pytest.fixture(autouse=True)
def reset_handler_cache():
    fc._compiled_handlers = None
    yield
    fc._compiled_handlers = None


# --- pure logic -------------------------------------------------------

def test_build_argv_substitutes_known_tokens_only():
    argv = fc._build_argv(
        ['tool', '${file}', '--flag', '${output}', 'literal'],
        {'${file}': 'in.txt', '${output}': 'out.txt'})
    assert argv == ['tool', 'in.txt', '--flag', 'out.txt', 'literal']


def test_build_env_merges_top_level_then_handler(monkeypatch):
    monkeypatch.setenv('FILECONVERTER_BASE', 'from-os-environ')
    settings = FakeSettings({'env': {'A': 'top', 'B': 'top'}})
    monkeypatch.setattr(fc, '_get_settings', lambda: settings)
    handler = {'env': {'B': 'handler'}}
    env = fc._build_env(handler)
    assert env['FILECONVERTER_BASE'] == 'from-os-environ'
    assert env['A'] == 'top'
    assert env['B'] == 'handler'  # handler overrides top-level


def test_find_handler_matches_configured_patterns(monkeypatch):
    settings = FakeSettings({
        'handlers': [
            {
                'id': 'a',
                'match': ['.*(\\\\|/)*,ff8$', '.*(\\\\|/)*,ffc$'],
                'decode_cmd': ['tool_a', '${file}'],
                'encode_cmd': None,
            },
            {
                'id': 'b',
                'match': ['.*(\\\\|/)*,aff$'],
                'decode_cmd': ['tool_b', '${file}'],
                'encode_cmd': ['tool_b', '${input}', '${output}'],
            },
        ]
    })
    monkeypatch.setattr(fc, '_get_settings', lambda: settings)

    assert fc.find_handler('/some/dir/Module,ff8')['id'] == 'a'
    assert fc.find_handler('/some/dir/Thing,ffc')['id'] == 'a'
    assert fc.find_handler('/some/dir/Drawing,aff')['id'] == 'b'
    assert fc.find_handler('/some/dir/Unrelated.txt') is None
    assert fc.find_handler(None) is None
    assert fc.find_handler_by_id('b')['id'] == 'b'
    assert fc.find_handler_by_id('missing') is None


# --- subprocess integration (no RISC OS tools needed) ------------------

def test_decode_process_streams_a_real_command():
    argv = ['printf', 'hello world']
    chunks = []
    done = {}
    proc = fc.DecodeProcess(argv, os.environ.copy(), '.',
                             lambda text: chunks.append(text),
                             lambda code, err: done.update(exit_code=code, stderr=err))
    proc._run()  # run synchronously; on_done uses sublime.set_timeout, stubbed to run inline
    assert ''.join(chunks) == 'hello world'
    assert done['exit_code'] == 0


def test_decode_process_reports_launch_failure():
    done = {}
    proc = fc.DecodeProcess(['this-command-does-not-exist-xyz'], os.environ.copy(), '.',
                             lambda text: None,
                             lambda code, err: done.update(exit_code=code, stderr=err))
    proc._run()
    assert done['exit_code'] is None
    assert done['stderr']


def test_file_decode_process_reads_output_file_and_cleans_up(tmp_path):
    src = tmp_path / 'source.txt'
    src.write_text('file mode content\n')
    output_path = tmp_path / 'out.tmp'

    chunks = []
    done = {}
    argv = ['cp', 'source.txt', 'out.tmp']
    proc = fc.FileDecodeProcess(argv, os.environ.copy(), str(tmp_path), str(output_path),
                                 lambda text: chunks.append(text),
                                 lambda code, err: done.update(exit_code=code, stderr=err))
    proc._run()
    assert ''.join(chunks) == 'file mode content\n'
    assert done['exit_code'] == 0
    assert not output_path.exists()  # cleaned up after reading


# --- run_decode integration --------------------------------------------

def test_run_decode_success_assigns_syntax_and_stays_editable_when_reversible(tmp_path):
    handler = {
        'id': 'h', 'decode_cmd': ['printf', 'text'], 'decode_mode': 'stdout',
        'output_syntax': 'Packages/Text/Plain text.tmLanguage',
        'encode_cmd': ['some-encoder'], 'encode_output_suffix': '', 'env': {},
    }
    window = FakeWindow()
    fc.run_decode(window, str(tmp_path / 'File,xyz'), handler)
    time.sleep(0.3)
    view = window.created_views[0]
    assert view.content == 'text'
    assert view.syntax == handler['output_syntax']
    assert view.read_only is False  # reversible formats stay editable
    assert view.settings().get('file_converter_decode_failed') is None


def test_run_decode_locks_read_only_when_no_encode_cmd(tmp_path):
    handler = {
        'id': 'h', 'decode_cmd': ['printf', 'text'], 'decode_mode': 'stdout',
        'output_syntax': None, 'encode_cmd': None, 'env': {},
    }
    window = FakeWindow()
    fc.run_decode(window, str(tmp_path / 'File,xyz'), handler)
    time.sleep(0.3)
    view = window.created_views[0]
    assert view.read_only is True


def test_run_decode_failure_disables_encode_buffer_command(monkeypatch, tmp_path):
    handler = {
        'id': 'broken', 'decode_cmd': ['this-command-does-not-exist-xyz'], 'decode_mode': 'stdout',
        'output_syntax': None, 'encode_cmd': ['also-fake'], 'encode_output_suffix': '', 'env': {},
    }
    monkeypatch.setattr(fc, 'find_handler_by_id', lambda hid: handler if hid == 'broken' else None)
    window = FakeWindow()
    fc.run_decode(window, str(tmp_path / 'File,xyz'), handler)
    time.sleep(0.3)
    view = window.created_views[0]
    assert view.settings().get('file_converter_decode_failed') is True

    cmd = fc.FileConverterEncodeBufferCommand.__new__(fc.FileConverterEncodeBufferCommand)
    cmd.view = view
    assert cmd.is_enabled() is False


def test_run_decode_closes_source_view_on_success(tmp_path):
    handler = {
        'id': 'h', 'decode_cmd': ['printf', 'text'], 'decode_mode': 'stdout',
        'output_syntax': None, 'encode_cmd': None, 'env': {},
    }
    source_path = str(tmp_path / 'File,xyz')
    window = FakeWindow()
    source_view = FakeView(file_name=source_path)
    fc.run_decode(window, source_path, handler, source_view=source_view)
    time.sleep(0.3)
    assert source_view.closed is True


# --- shipped config sanity ----------------------------------------------

def _load_jsonc(path):
    with open(path) as f:
        text = f.read()
    text = re.sub(r'^\s*//.*$', '', text, flags=re.MULTILINE)
    return json.loads(text)


@pytest.mark.parametrize('filename', [
    'FileConverter.sublime-settings',
    'FileConverter.sublime-commands',
    'Context.sublime-menu',
    'Main.sublime-menu',
])
def test_config_file_is_valid_json(filename):
    _load_jsonc(os.path.join(REPO_ROOT, filename))


def test_shipped_handlers_are_well_formed():
    data = _load_jsonc(os.path.join(REPO_ROOT, 'FileConverter.sublime-settings'))
    handlers = data['handlers']
    assert handlers, 'expected at least one handler'
    seen_ids = set()
    for handler in handlers:
        assert handler['id'] not in seen_ids, 'duplicate handler id: {0}'.format(handler['id'])
        seen_ids.add(handler['id'])
        assert isinstance(handler['match'], list) and handler['match']
        for pattern in handler['match']:
            re.compile(pattern)  # must be a valid regex
        assert isinstance(handler['decode_cmd'], list) and handler['decode_cmd']
        assert all(isinstance(arg, str) for arg in handler['decode_cmd'])
        if handler.get('encode_cmd') is not None:
            assert isinstance(handler['encode_cmd'], list) and handler['encode_cmd']
            assert all(isinstance(arg, str) for arg in handler['encode_cmd'])


# --- Sublime Text 3 (Python 3.3) compatibility --------------------------

def test_no_fstrings_for_python_3_3_compatibility():
    with open(os.path.join(REPO_ROOT, 'FileConverter.py')) as f:
        tree = ast.parse(f.read())
    joined_strs = [node for node in ast.walk(tree) if isinstance(node, ast.JoinedStr)]
    assert not joined_strs, 'f-strings are not supported by ST3\'s Python 3.3 host'
