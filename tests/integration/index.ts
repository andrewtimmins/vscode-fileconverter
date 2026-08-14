/**
 * Integration checks, run inside a real VS Code extension host by runTest.ts.
 *
 * These use ordinary Unix tools (`xxd`, `cat`, `cp`) standing in for the shape
 * of a real handler, so they need none of the RISC OS tooling.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

function log(message: string): void {
	console.log(`[integration] ${message}`);
}

/** Polls until `predicate` returns something truthy, or gives up. */
async function waitFor<T>(what: string, predicate: () => T | undefined | false, timeoutMs = 20000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = predicate();
		if (value) {
			return value;
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

function decodedDocuments(): vscode.TextDocument[] {
	return vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'fileconverter');
}

function setHandlers(handlers: unknown[]): Thenable<void> {
	return vscode.workspace
		.getConfiguration('fileconverter')
		.update('handlers', handlers, vscode.ConfigurationTarget.Global);
}

/** Opens a file the way a user would, so the tab event that drives
 *  interception actually fires. */
async function openRaw(filePath: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
	await vscode.window.showTextDocument(document);
}

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension('andrewtimmins.fileconverter');
	assert.ok(extension, 'the extension was not found in the host');
	await extension.activate();

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileconverter-integration-'));

	// --- a matching file is intercepted and decoded ------------------------
	const sample = path.join(dir, 'sample.bin');
	fs.writeFileSync(sample, 'FileConverter integration sample payload\n');
	const expected = execFileSync('xxd', ['sample.bin'], { cwd: dir }).toString();

	await openRaw(sample);
	const decoded = await waitFor('a decoded document to appear', () => decodedDocuments()[0]);
	await waitFor(
		'the decoded content to finish streaming',
		() => decoded.getText().trim() === expected.trim(),
	);
	log('decoded content matches the command output exactly');

	// --- the raw editor is closed, so it cannot be saved over --------------
	const rawTabs = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file');
	assert.deepEqual(rawTabs, [], 'the raw file editor should have been closed');

	// --- and the decoded document is not associated with the source --------
	assert.equal(decoded.uri.scheme, 'fileconverter');
	assert.notEqual(decoded.uri.fsPath, sample);
	log('decoded document is detached from the source path');

	// --- a handler with no encode command is locked ------------------------
	const stat = await vscode.workspace.fs.stat(decoded.uri);
	assert.equal(
		(stat.permissions ?? 0) & vscode.FilePermission.Readonly,
		vscode.FilePermission.Readonly,
		'a format with no reverse direction must be read-only',
	);
	log('non-reversible output is read-only');

	// --- a handler with one stays editable ---------------------------------
	await setHandlers([
		{
			id: 'roundtrip',
			match: ['.*\\.rt$'],
			decode_cmd: ['cat', '${file}'],
			encode_cmd: ['cp', '${input}', '${output}'],
			encode_output_suffix: '',
			env: {},
		},
	]);
	const reversible = path.join(dir, 'thing.rt');
	fs.writeFileSync(reversible, 'reversible payload\n');

	await openRaw(reversible);
	const reversibleDoc = await waitFor('the reversible document', () =>
		decodedDocuments().find((d) => d.uri.path.endsWith('thing.rt (decoded)')),
	);
	await waitFor('its content', () => reversibleDoc.getText() === 'reversible payload\n');
	const reversibleStat = await vscode.workspace.fs.stat(reversibleDoc.uri);
	assert.ok(
		!((reversibleStat.permissions ?? 0) & vscode.FilePermission.Readonly),
		'a handler with an encode command must stay editable',
	);
	log('reversible output stays editable');

	// --- a decode that cannot launch is reported, not silent ---------------
	await setHandlers([
		{
			id: 'broken',
			match: ['.*\\.broken$'],
			decode_cmd: ['this-command-does-not-exist-xyz', '${file}'],
			encode_cmd: null,
			env: {},
		},
	]);
	const broken = path.join(dir, 'thing.broken');
	fs.writeFileSync(broken, 'x');

	await openRaw(broken);
	const brokenDoc = await waitFor('the failed decode document', () =>
		decodedDocuments().find((d) => d.uri.path.endsWith('thing.broken (decoded)')),
	);
	await waitFor('the failure to be written into the document', () =>
		/failed to launch/.test(brokenDoc.getText()),
	);
	log('a decode that cannot launch is reported in the document');

	fs.rmSync(dir, { recursive: true, force: true });
	log('all integration checks passed');
}
