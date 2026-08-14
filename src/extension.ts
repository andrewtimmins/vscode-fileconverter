/**
 * FileConverter: open files matching a configured pattern by running them
 * through an external command, instead of loading the raw file as text.
 *
 * Originally written by Charles Ferguson (gerph) as a Sublime Text plugin:
 * https://github.com/gerph/sublimetext-fileconverter
 * Ported to Visual Studio Code by Andrew Timmins. MIT licensed; see LICENSE,
 * which retains the original copyright.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { runFileDecode, runStdoutDecode, type RunningDecode } from './decode.js';
import { DecodedDocumentProvider, SCHEME, tokenOf } from './documents.js';
import { runEncode } from './encode.js';
import {
	buildArgv,
	buildEnv,
	canEncode,
	compileHandlers,
	findHandler,
	findHandlerById,
	type Handler,
	type HandlerConfig,
} from './handlers.js';

let provider: DecodedDocumentProvider;
let handlers: Handler[] = [];
let output: vscode.OutputChannel;

/** Source URIs currently being swapped for a decoded document, so a repeated
 *  tab event for the same file can't start the decode twice. */
const intercepting = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel('FileConverter');
	provider = new DecodedDocumentProvider();
	loadHandlers();

	context.subscriptions.push(
		output,
		vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('fileconverter')) {
				loadHandlers();
				updateContextKeys();
			}
		}),
		vscode.window.tabGroups.onDidChangeTabs(onTabsChanged),
		vscode.window.onDidChangeActiveTextEditor(() => updateContextKeys()),
		vscode.commands.registerCommand('fileconverter.decodeFile', decodeFileCommand),
		vscode.commands.registerCommand('fileconverter.encodeBuffer', encodeBufferCommand),
		vscode.commands.registerCommand('fileconverter.revealSource', revealSourceCommand),
		vscode.commands.registerCommand('fileconverter.copySourcePath', copySourcePathCommand),
		vscode.commands.registerCommand('fileconverter.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'fileconverter'),
		),
	);

	// A restored session activates the extension *after* its tabs are back, so
	// no onDidChangeTabs event ever fires for them. Catch them here instead.
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			reportFailure(considerTab(tab));
		}
	}

	updateContextKeys();
}

export function deactivate(): void {
	provider?.disposeAll();
}

// --- configuration --------------------------------------------------------

function loadHandlers(): void {
	const configs = vscode.workspace
		.getConfiguration('fileconverter')
		.get<HandlerConfig[]>('handlers', []);
	handlers = compileHandlers(configs, (message) => {
		output.appendLine(message);
		void vscode.window.showErrorMessage(`FileConverter: ${message}`);
	});
}

function globalEnv(): Record<string, string> {
	return vscode.workspace.getConfiguration('fileconverter').get<Record<string, string>>('env', {});
}

// --- intercepting the open ------------------------------------------------

function onTabsChanged(e: vscode.TabChangeEvent): void {
	for (const tab of e.opened) {
		reportFailure(considerTab(tab));
	}
	for (const tab of e.closed) {
		const uri = tabUri(tab);
		if (uri?.scheme === SCHEME) {
			// Tab gone, nothing can refer to it: stop any decode still running
			// for it and drop the content.
			provider.dispose(tokenOf(uri));
		}
	}
}

async function considerTab(tab: vscode.Tab): Promise<void> {
	const uri = tabUri(tab);
	if (uri?.scheme !== 'file') {
		return;
	}
	const handler = findHandler(handlers, uri.fsPath);
	if (!handler) {
		return;
	}
	const key = uri.toString();
	if (intercepting.has(key)) {
		return;
	}
	intercepting.add(key);
	try {
		// Close the raw editor VS Code already opened (garbled bytes as text,
		// or a "binary file" placeholder) before it can be edited or saved
		// back over the source file.
		await vscode.window.tabGroups.close(tab, true);
	} finally {
		// Released as soon as the swap itself is done, not once the decode
		// finishes: a slow decode shouldn't stop the same file being opened
		// again deliberately.
		intercepting.delete(key);
	}
	await decodeAndShow(uri.fsPath, handler);
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
	const input = tab.input;
	if (input instanceof vscode.TabInputText) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

// --- decoding -------------------------------------------------------------

/**
 * Shared entry point for both the auto-open trigger and the manual "Decode
 * File" command: streams the handler's decode command into a brand-new
 * document under the fileconverter scheme, never associated with sourcePath.
 */
async function decodeAndShow(sourcePath: string, handler: Handler): Promise<void> {
	if (!handler.decodeCmd || handler.decodeCmd.length === 0) {
		showError(`handler "${handler.id || '?'}" has no decode command configured.`);
		return;
	}

	const { uri, token } = provider.create(sourcePath, handler);
	const opened = await vscode.workspace.openTextDocument(uri);
	// Setting the language replaces the document object, so show whichever
	// one came back rather than the one opened above.
	const document = await applyLanguage(opened, handler.language);
	await vscode.window.showTextDocument(document, { preview: false });

	// Run with the working directory set to the file's own directory and pass
	// its bare basename for "${file}", rather than an absolute path: some
	// external tools (verified with a Docker-wrapped riscos-mkdrawf) only
	// resolve paths correctly relative to the working directory.
	const cwd = path.dirname(sourcePath) || '.';
	const env = buildEnv(process.env, globalEnv(), handler.env);
	const onData = (text: string) => provider.append(token, uri, text);

	let running: RunningDecode;
	if (handler.decodeMode === 'file') {
		// This tool has no stdout mode at all (verified with riscos-ccres): it
		// always writes its result to an output file argument. Give it a
		// throwaway relative name in the same directory (same reasoning as the
		// cwd/basename choice above) and read it back once it has finished.
		const outputName = `.fileconverter-decode-${randomUUID().replace(/-/g, '')}.tmp`;
		running = runFileDecode({
			argv: buildArgv(handler.decodeCmd, {
				'${file}': path.basename(sourcePath),
				'${output}': outputName,
			}),
			env,
			cwd,
			outputPath: path.join(cwd, outputName),
			onData,
		});
	} else {
		running = runStdoutDecode({
			argv: buildArgv(handler.decodeCmd, { '${file}': path.basename(sourcePath) }),
			env,
			cwd,
			onData,
		});
	}

	const entry = provider.getByToken(token);
	if (entry) {
		entry.cancel = running.cancel;
	}

	const result = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: `FileConverter: decoding ${path.basename(sourcePath)}…`,
		},
		() => running.done,
	);

	const failed = result.exitCode !== 0;
	if (result.exitCode === null) {
		onData(`\n--- failed to launch: ${result.stderr} ---\n`);
		showError(`failed to launch decode command:\n${result.stderr}`);
	} else if (result.exitCode !== 0) {
		onData(`\n--- stderr (exit ${result.exitCode}) ---\n${result.stderr}`);
		showError(`decode command exited with status ${result.exitCode}.`);
	} else {
		vscode.window.setStatusBarMessage(`FileConverter: decoded ${sourcePath}`, 5000);
	}

	const finished = provider.getByToken(token);
	if (finished) {
		finished.finished = true;
		finished.decodeFailed = failed;
		finished.cancel = () => {};
	}
	provider.flush(token, uri);
	updateContextKeys();
}

/** Applies the handler's language for syntax highlighting, if some installed
 *  extension actually provides it. Unlike Sublime's syntax paths, an unknown
 *  language id here is simply left alone rather than treated as an error. */
async function applyLanguage(
	document: vscode.TextDocument,
	language: string | null,
): Promise<vscode.TextDocument> {
	if (!language) {
		return document;
	}
	const available = await vscode.languages.getLanguages();
	if (!available.includes(language)) {
		output.appendLine(
			`no installed extension provides the language "${language}"; leaving the decoded document as plain text`,
		);
		return document;
	}
	return vscode.languages.setTextDocumentLanguage(document, language);
}

// --- commands -------------------------------------------------------------

async function decodeFileCommand(resource?: vscode.Uri): Promise<void> {
	const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
	if (!uri || uri.scheme !== 'file') {
		showError('no file selected to decode.');
		return;
	}
	const handler = findHandler(handlers, uri.fsPath);
	if (!handler) {
		showError(`no handler configured for ${uri.fsPath}`);
		return;
	}
	await decodeAndShow(uri.fsPath, handler);
}

async function encodeBufferCommand(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const entry = activeDecodedDocument();
	const handler = entry ? findHandlerById(handlers, entry.handlerId) : null;
	if (!editor || !entry || !handler?.encodeCmd) {
		showError('no encode command configured for this document.');
		return;
	}
	if (entry.decodeFailed) {
		showError('this document failed to decode, so there is nothing safe to encode back.');
		return;
	}

	const text = editor.document.getText();
	const sourcePath = entry.sourcePath;

	const choice = await vscode.window.showInformationMessage(
		`Save the encoded output as a new file, or overwrite the original (${sourcePath})?`,
		{ modal: true },
		'Save As…',
		'Overwrite Original',
	);
	if (!choice) {
		return;
	}

	let destPath: string;
	if (choice === 'Overwrite Original') {
		const confirmed = await vscode.window.showWarningMessage(
			`This will replace ${sourcePath}. This cannot be undone. Continue?`,
			{ modal: true },
			'Overwrite',
		);
		if (confirmed !== 'Overwrite') {
			return;
		}
		destPath = sourcePath;
	} else {
		const picked = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(sourcePath) });
		if (!picked) {
			return;
		}
		destPath = picked.fsPath;
	}

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'FileConverter: encoding…' },
		() =>
			runEncode({
				text,
				encodeCmd: handler.encodeCmd!,
				encodeOutputSuffix: handler.encodeOutputSuffix,
				destPath,
				env: buildEnv(process.env, globalEnv(), handler.env),
			}),
	);

	if (result.ok) {
		vscode.window.setStatusBarMessage(`FileConverter: wrote ${result.path}`, 5000);
	} else {
		showError(result.message);
	}
}

/** The decoded document has no path of its own to reveal, which is
 *  deliberate, so this uses the source path recorded at decode time. */
async function revealSourceCommand(): Promise<void> {
	const entry = activeDecodedDocument();
	if (entry) {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.sourcePath));
	}
}

async function copySourcePathCommand(): Promise<void> {
	const entry = activeDecodedDocument();
	if (entry) {
		await vscode.env.clipboard.writeText(entry.sourcePath);
		vscode.window.setStatusBarMessage(`FileConverter: copied ${entry.sourcePath}`, 5000);
	}
}

// --- shared helpers -------------------------------------------------------

function activeDecodedDocument() {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === SCHEME ? provider.get(uri) : undefined;
}

/** Drives the `when` clauses that grey out the decoded-document commands,
 *  including "Re-encode As…" when the decode itself failed. */
function updateContextKeys(): void {
	const entry = activeDecodedDocument();
	const handler = entry ? findHandlerById(handlers, entry.handlerId) : null;
	void vscode.commands.executeCommand('setContext', 'fileconverter.activeHasSource', !!entry);
	void vscode.commands.executeCommand(
		'setContext',
		'fileconverter.activeCanEncode',
		!!entry && canEncode(handler, entry.decodeFailed),
	);
}

function showError(message: string): void {
	output.appendLine(message);
	void vscode.window.showErrorMessage(`FileConverter: ${message}`);
}

/** Interception runs detached from any command invocation, so a failure has
 *  nowhere to propagate to; surface it rather than let it become an unhandled
 *  rejection in the extension host. */
function reportFailure(work: Promise<void>): void {
	void work.catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
}
