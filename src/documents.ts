/**
 * The decoded documents themselves, served to VS Code as a virtual file
 * system under the "fileconverter" scheme.
 *
 * A virtual scheme is what replaces Sublime's scratch view: the document is
 * never associated with the source file's path, so there is no risk of the
 * decoded output being saved back over the source. It also gets us per-file
 * read-only control, via FilePermission.Readonly in stat(), which is what
 * locks down formats with no reverse direction whilst leaving re-encodable
 * ones editable.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { isReadOnly, type Handler } from './handlers.js';

export const SCHEME = 'fileconverter';

/** How often, at most, a growing document is republished whilst streaming. */
const STREAM_FLUSH_MS = 150;

export interface DecodedDocument {
	token: string;
	/** The file this was decoded from. Kept here rather than on the document
	 *  because the document deliberately has no path of its own. */
	sourcePath: string;
	handlerId: string;
	content: string;
	/** True when the handler has no encode_cmd: nothing useful to do here but
	 *  read it, so it is locked. */
	readOnly: boolean;
	decodeFailed: boolean;
	finished: boolean;
	cancel: () => void;
	ctime: number;
	mtime: number;
}

export class DecodedDocumentProvider implements vscode.FileSystemProvider {
	private readonly documents = new Map<string, DecodedDocument>();
	private readonly flushTimers = new Map<string, NodeJS.Timeout>();
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	readonly onDidChangeFile = this.emitter.event;

	/** Registers a new, empty decoded document and returns the URI to open.
	 *  The document must exist before it is opened, or the first readFile
	 *  would fail; it is then filled in as the decode streams. */
	create(sourcePath: string, handler: Handler): { uri: vscode.Uri; token: string } {
		const token = randomToken();
		const now = Date.now();
		this.documents.set(token, {
			token,
			sourcePath,
			handlerId: handler.id,
			content: '',
			readOnly: isReadOnly(handler),
			decodeFailed: false,
			finished: false,
			cancel: () => {},
			ctime: now,
			mtime: now,
		});
		// The token segment keeps two same-named files from colliding; the
		// last segment is what VS Code shows as the tab title.
		const uri = vscode.Uri.from({
			scheme: SCHEME,
			path: `/${token}/${path.basename(sourcePath)} (decoded)`,
		});
		return { uri, token };
	}

	get(uri: vscode.Uri): DecodedDocument | undefined {
		return this.documents.get(tokenOf(uri));
	}

	getByToken(token: string): DecodedDocument | undefined {
		return this.documents.get(token);
	}

	/** Appends a chunk of decoded output, republishing at most every
	 *  STREAM_FLUSH_MS so a chatty command doesn't thrash the editor. */
	append(token: string, uri: vscode.Uri, text: string): void {
		const document = this.documents.get(token);
		if (!document) {
			return;
		}
		document.content += text;
		document.mtime = Date.now();
		if (this.flushTimers.has(token)) {
			return;
		}
		this.flushTimers.set(
			token,
			setTimeout(() => {
				this.flushTimers.delete(token);
				this.fireChanged(uri);
			}, STREAM_FLUSH_MS),
		);
	}

	/** Publishes any buffered content immediately, used once decoding ends,
	 *  so the last chunk isn't left waiting on a timer. */
	flush(token: string, uri: vscode.Uri): void {
		const timer = this.flushTimers.get(token);
		if (timer) {
			clearTimeout(timer);
			this.flushTimers.delete(token);
		}
		// The tab may have been closed mid-decode, taking the document with
		// it; there is then nothing left to publish a change for.
		if (this.documents.has(token)) {
			this.fireChanged(uri);
		}
	}

	/** Cancels any running decode and forgets the document, once its tab has
	 *  gone and nothing can refer to it any more. */
	dispose(token: string): void {
		const document = this.documents.get(token);
		if (!document) {
			return;
		}
		document.cancel();
		const timer = this.flushTimers.get(token);
		if (timer) {
			clearTimeout(timer);
			this.flushTimers.delete(token);
		}
		this.documents.delete(token);
	}

	/** Stops every running decode: the extension host is going away. */
	disposeAll(): void {
		for (const token of [...this.documents.keys()]) {
			this.dispose(token);
		}
	}

	private fireChanged(uri: vscode.Uri): void {
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	// --- FileSystemProvider ----------------------------------------------

	watch(): vscode.Disposable {
		// Nothing outside this extension can change these documents, so
		// there is no external source of change events to subscribe to.
		return new vscode.Disposable(() => {});
	}

	stat(uri: vscode.Uri): vscode.FileStat {
		const document = this.mustGet(uri);
		return {
			type: vscode.FileType.File,
			ctime: document.ctime,
			mtime: document.mtime,
			size: Buffer.byteLength(document.content, 'utf8'),
			permissions: document.readOnly ? vscode.FilePermission.Readonly : undefined,
		};
	}

	readFile(uri: vscode.Uri): Uint8Array {
		return Buffer.from(this.mustGet(uri).content, 'utf8');
	}

	writeFile(uri: vscode.Uri, content: Uint8Array): void {
		// Reached when the user saves an editable decoded document. It is kept
		// in memory only. Writing the result back to a real file is what the
		// "Re-encode As…" command is for, and it never happens implicitly.
		const document = this.mustGet(uri);
		if (document.readOnly) {
			throw vscode.FileSystemError.NoPermissions(uri);
		}
		document.content = Buffer.from(content).toString('utf8');
		document.mtime = Date.now();
		this.fireChanged(uri);
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		throw vscode.FileSystemError.FileNotADirectory(uri);
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(oldUri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(oldUri);
	}

	private mustGet(uri: vscode.Uri): DecodedDocument {
		const document = this.documents.get(tokenOf(uri));
		if (!document) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return document;
	}
}

/** The path is always "/<token>/<title>". */
export function tokenOf(uri: vscode.Uri): string {
	return uri.path.split('/')[1] ?? '';
}

function randomToken(): string {
	return randomUUID().replace(/-/g, '');
}
