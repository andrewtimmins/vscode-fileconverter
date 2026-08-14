import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import { compileHandlers, type HandlerConfig } from '../src/handlers.js';

const REPO_ROOT = path.join(__dirname, '..', '..');

function manifest(): any {
	return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
}

function shippedHandlers(): HandlerConfig[] {
	return manifest().contributes.configuration.properties['fileconverter.handlers'].default;
}

test('the manifest declares every contributed command in the palette', () => {
	const contributed: string[] = manifest().contributes.commands.map((c: any) => c.command);
	assert.ok(contributed.length > 0);
	for (const command of contributed) {
		assert.match(command, /^fileconverter\./);
	}
});

test('the shipped handlers are well formed', () => {
	const handlers = shippedHandlers();
	assert.ok(handlers.length > 0, 'expected at least one handler');

	const seen = new Set<string>();
	for (const handler of handlers) {
		assert.ok(handler.id, 'every handler needs an id');
		assert.ok(!seen.has(handler.id!), `duplicate handler id: ${handler.id}`);
		seen.add(handler.id!);

		assert.ok(Array.isArray(handler.match) && handler.match.length > 0);
		for (const pattern of handler.match) {
			new RegExp(pattern); // must be a valid regex
		}

		assert.ok(Array.isArray(handler.decode_cmd) && handler.decode_cmd.length > 0);
		assert.ok(handler.decode_cmd.every((arg) => typeof arg === 'string'));

		if (handler.encode_cmd !== null && handler.encode_cmd !== undefined) {
			assert.ok(Array.isArray(handler.encode_cmd) && handler.encode_cmd.length > 0);
			assert.ok(handler.encode_cmd.every((arg) => typeof arg === 'string'));
		}
	}
});

test('the shipped handlers compile without error', () => {
	const errors: string[] = [];
	const handlers = compileHandlers(shippedHandlers(), (message) => errors.push(message));
	assert.deepEqual(errors, []);
	assert.equal(handlers.length, shippedHandlers().length);
});

test('every handler command referencing ${file} declares it in decode_cmd', () => {
	for (const handler of shippedHandlers()) {
		assert.ok(
			handler.decode_cmd!.includes('${file}'),
			`handler ${handler.id} never passes the file to its decode command`,
		);
	}
});

test('only the editor-facing modules import vscode', () => {
	// The conversion engine is kept free of the editor API so it can be tested
	// in plain Node, without an extension host, the same reason the Sublime
	// original stubbed its `sublime` module in CI.
	const editorFacing = new Set(['extension.ts', 'documents.ts']);
	const srcDir = path.join(REPO_ROOT, 'src');

	for (const name of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
		const source = readFileSync(path.join(srcDir, name), 'utf8');
		const importsVscode = /from ['"]vscode['"]/.test(source);
		if (editorFacing.has(name)) {
			assert.ok(importsVscode, `${name} is expected to be an editor-facing module`);
		} else {
			assert.ok(!importsVscode, `${name} must stay free of the vscode API to remain testable`);
		}
	}
});
