import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

import { runFileDecode, runStdoutDecode } from '../src/decode.js';

let workDir: string;

before(async () => {
	workDir = await mkdtemp(path.join(tmpdir(), 'fileconverter-decode-'));
});

after(async () => {
	await rm(workDir, { recursive: true, force: true });
});

test('runStdoutDecode streams a real command', async () => {
	const chunks: string[] = [];
	const { done } = runStdoutDecode({
		argv: ['printf', 'hello world'],
		env: process.env,
		cwd: '.',
		onData: (text) => chunks.push(text),
	});
	const result = await done;
	assert.equal(chunks.join(''), 'hello world');
	assert.equal(result.exitCode, 0);
});

test('runStdoutDecode reports a launch failure', async () => {
	const { done } = runStdoutDecode({
		argv: ['this-command-does-not-exist-xyz'],
		env: process.env,
		cwd: '.',
		onData: () => {},
	});
	const result = await done;
	assert.equal(result.exitCode, null, 'null exit code means it could not be launched at all');
	assert.ok(result.stderr, 'the launch error is reported in place of stderr');
});

test('runStdoutDecode captures stderr and a non-zero exit', async () => {
	const { done } = runStdoutDecode({
		argv: ['sh', '-c', 'printf oops >&2; exit 3'],
		env: process.env,
		cwd: '.',
		onData: () => {},
	});
	const result = await done;
	assert.equal(result.exitCode, 3);
	assert.equal(result.stderr, 'oops');
});

test('runStdoutDecode reassembles a multi-byte character split across reads', async () => {
	// £ is two bytes in UTF-8; a naive per-chunk toString() would corrupt it
	// if the read boundary landed between them.
	const text = '£'.repeat(5000);
	const chunks: string[] = [];
	const { done } = runStdoutDecode({
		argv: ['printf', '%s', text],
		env: process.env,
		cwd: '.',
		onData: (chunk) => chunks.push(chunk),
	});
	await done;
	assert.equal(chunks.join(''), text);
});

test('runFileDecode reads the output file and cleans up', async () => {
	await fs.writeFile(path.join(workDir, 'source.txt'), 'file mode content\n');
	const outputPath = path.join(workDir, 'out.tmp');

	const chunks: string[] = [];
	const { done } = runFileDecode({
		argv: ['cp', 'source.txt', 'out.tmp'],
		env: process.env,
		cwd: workDir,
		outputPath,
		onData: (text) => chunks.push(text),
	});
	const result = await done;

	assert.equal(chunks.join(''), 'file mode content\n');
	assert.equal(result.exitCode, 0);
	await assert.rejects(fs.access(outputPath), 'the temporary output is removed after reading');
});

test('runFileDecode reports a command that succeeds without producing output', async () => {
	const { done } = runFileDecode({
		argv: ['true'],
		env: process.env,
		cwd: workDir,
		outputPath: path.join(workDir, 'never-created.tmp'),
		onData: () => {},
	});
	const result = await done;
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /output could not be read/);
});

test('cancel kills a running decode', async () => {
	const { done, cancel } = runStdoutDecode({
		argv: ['sleep', '30'],
		env: process.env,
		cwd: '.',
		onData: () => {},
	});
	cancel();
	const result = await done;
	assert.notEqual(result.exitCode, 0, 'a killed command must not look like a clean decode');
});
