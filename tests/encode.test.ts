import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { runEncode } from '../src/encode.js';

let workDir: string;

beforeEach(async () => {
	workDir = await mkdtemp(path.join(tmpdir(), 'fileconverter-encode-'));
});

afterEach(async () => {
	await rm(workDir, { recursive: true, force: true });
});

/** Stands in for a tool that writes exactly to the output name it is given. */
const COPY_ENCODER = ['cp', '${input}', '${output}'];

/** Stands in for riscos-mkdrawf, which always appends ",aff" to whatever
 *  output name it is given. */
const SUFFIX_ENCODER = ['sh', '-c', 'cp "$1" "$2,aff"', 'sh', '${input}', '${output}'];

test('runEncode writes the encoded result to the destination', async () => {
	const destPath = path.join(workDir, 'result.bin');
	const result = await runEncode({
		text: 'encoded content\n',
		encodeCmd: COPY_ENCODER,
		encodeOutputSuffix: '',
		destPath,
		env: process.env,
	});

	assert.deepEqual(result, { ok: true, path: destPath });
	assert.equal(await fs.readFile(destPath, 'utf8'), 'encoded content\n');
});

test('runEncode removes its temporary input file', async () => {
	await runEncode({
		text: 'content',
		encodeCmd: COPY_ENCODER,
		encodeOutputSuffix: '',
		destPath: path.join(workDir, 'result.bin'),
		env: process.env,
	});
	const leftovers = (await fs.readdir(workDir)).filter((name) => name.startsWith('.fileconverter-input-'));
	assert.deepEqual(leftovers, []);
});

test('runEncode strips a suffix the command appends itself', async () => {
	// Passing "Drawing,aff" straight through would produce "Drawing,aff,aff".
	const destPath = path.join(workDir, 'Drawing,aff');
	const result = await runEncode({
		text: 'draw content',
		encodeCmd: SUFFIX_ENCODER,
		encodeOutputSuffix: ',aff',
		destPath,
		env: process.env,
	});

	assert.equal(result.ok, true);
	assert.equal(await fs.readFile(destPath, 'utf8'), 'draw content');
	assert.deepEqual(await fs.readdir(workDir), ['Drawing,aff'], 'no doubly-suffixed file left behind');
});

test('runEncode renames the produced file when it does not match the destination', async () => {
	// A destination that doesn't already end in the suffix: the command still
	// produces "Other.draw,aff", which is then moved into place.
	const destPath = path.join(workDir, 'Other.draw');
	const result = await runEncode({
		text: 'draw content',
		encodeCmd: SUFFIX_ENCODER,
		encodeOutputSuffix: ',aff',
		destPath,
		env: process.env,
	});

	assert.equal(result.ok, true);
	assert.equal(await fs.readFile(destPath, 'utf8'), 'draw content');
	assert.deepEqual(await fs.readdir(workDir), ['Other.draw']);
});

test('runEncode reports a non-zero exit', async () => {
	const result = await runEncode({
		text: 'content',
		encodeCmd: ['sh', '-c', 'printf "bad input" >&2; exit 2'],
		encodeOutputSuffix: '',
		destPath: path.join(workDir, 'result.bin'),
		env: process.env,
	});

	assert.equal(result.ok, false);
	assert.match(result.ok ? '' : result.message, /exited with status 2/);
	assert.match(result.ok ? '' : result.message, /bad input/);
});

test('runEncode reports a command that succeeds without producing the file', async () => {
	const result = await runEncode({
		text: 'content',
		encodeCmd: ['true'],
		encodeOutputSuffix: '',
		destPath: path.join(workDir, 'result.bin'),
		env: process.env,
	});

	assert.equal(result.ok, false);
	assert.match(result.ok ? '' : result.message, /was not created/);
});

test('runEncode reports a launch failure', async () => {
	const result = await runEncode({
		text: 'content',
		encodeCmd: ['this-command-does-not-exist-xyz'],
		encodeOutputSuffix: '',
		destPath: path.join(workDir, 'result.bin'),
		env: process.env,
	});

	assert.equal(result.ok, false);
	assert.match(result.ok ? '' : result.message, /failed to launch/);
});
