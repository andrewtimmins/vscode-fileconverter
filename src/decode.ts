/**
 * Running decode commands. No `vscode` import here either; see handlers.ts.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface DecodeResult {
	/** The command's exit status, or null if it could not be launched at all,
	 *  in which case `stderr` holds the launch error instead. */
	exitCode: number | null;
	stderr: string;
}

export interface DecodeOptions {
	argv: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Called for each chunk of decoded output, as it is produced. */
	onData: (text: string) => void;
}

export interface RunningDecode {
	done: Promise<DecodeResult>;
	/** Kills the command; `done` still settles, with whatever was produced. */
	cancel: () => void;
}

/**
 * Streams the command's stdout through onData as it arrives, which is useful
 * for slow tools, or tools whose output would otherwise not appear until they
 * finish.
 */
export function runStdoutDecode(options: DecodeOptions): RunningDecode {
	const { argv, env, cwd, onData } = options;
	let cancel = () => {};

	const done = new Promise<DecodeResult>((resolve) => {
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (e) {
			resolve({ exitCode: null, stderr: e instanceof Error ? e.message : String(e) });
			return;
		}

		cancel = () => child.kill();

		// Incremental, so a multi-byte character split across two reads is
		// still decoded correctly rather than becoming two replacement chars.
		const stdoutDecoder = new StringDecoder('utf8');
		const stderrChunks: Buffer[] = [];
		let launchError: string | null = null;

		child.stdout.on('data', (chunk: Buffer) => {
			const text = stdoutDecoder.write(chunk);
			if (text) {
				onData(text);
			}
		});
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

		// Fires instead of (not as well as) 'close' when the command itself
		// could not be started, e.g. it isn't on PATH.
		child.on('error', (e: Error) => {
			launchError = e.message;
		});

		child.on('close', (code) => {
			const tail = stdoutDecoder.end();
			if (tail) {
				onData(tail);
			}
			if (launchError !== null) {
				resolve({ exitCode: null, stderr: launchError });
				return;
			}
			resolve({
				exitCode: code,
				stderr: Buffer.concat(stderrChunks).toString('utf8'),
			});
		});
	});

	return { done, cancel: () => cancel() };
}

export interface FileDecodeOptions extends DecodeOptions {
	/** Where the command has been told to write its result. */
	outputPath: string;
}

/**
 * For a command that writes its result to an output *file* rather than stdout
 * and has no stdout mode at all. Not a true incremental stream (the tool
 * doesn't support one): the whole output file is read and delivered in a
 * single onData call once the command finishes. Same contract as
 * runStdoutDecode, so callers don't need to care which one they got.
 */
export function runFileDecode(options: FileDecodeOptions): RunningDecode {
	const { argv, env, cwd, outputPath, onData } = options;
	let cancel = () => {};

	const done = new Promise<DecodeResult>((resolve) => {
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (e) {
			resolve({ exitCode: null, stderr: e instanceof Error ? e.message : String(e) });
			return;
		}

		cancel = () => child.kill();

		const stderrChunks: Buffer[] = [];
		let launchError: string | null = null;

		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		child.on('error', (e: Error) => {
			launchError = e.message;
		});

		child.on('close', async (code) => {
			if (launchError !== null) {
				resolve({ exitCode: null, stderr: launchError });
				return;
			}

			let exitCode = code;
			let stderr = Buffer.concat(stderrChunks).toString('utf8');

			if (exitCode === 0) {
				try {
					const text = await fs.readFile(outputPath, 'utf8');
					if (text) {
						onData(text);
					}
				} catch (e) {
					exitCode = -1;
					stderr = `command exited successfully but output could not be read: ${
						e instanceof Error ? e.message : String(e)
					}`;
				} finally {
					await fs.rm(outputPath, { force: true }).catch(() => {});
				}
			}

			resolve({ exitCode, stderr });
		});
	});

	return { done, cancel: () => cancel() };
}
