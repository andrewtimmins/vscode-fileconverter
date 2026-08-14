/**
 * Running encode commands: the reverse direction, for formats whose handler
 * defines an `encode_cmd`. No `vscode` import here either.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { buildArgv } from './handlers.js';

export type EncodeResult = { ok: true; path: string } | { ok: false; message: string };

export interface EncodeOptions {
	/** The decoded text to convert back to the original binary format. */
	text: string;
	encodeCmd: string[];
	/** Suffix the command appends to whatever output name it is given. */
	encodeOutputSuffix: string;
	/** Where the caller wants the encoded file to end up. */
	destPath: string;
	env: NodeJS.ProcessEnv;
}

/**
 * Writes `text` to a temporary file, runs the encode command over it, and
 * moves the result into place at `destPath`.
 *
 * `${input}` and `${output}` are substituted as *basenames*, with the command's
 * working directory set to the destination folder, rather than being passed as
 * absolute paths: some external tools (verified with a Docker-wrapped
 * riscos-mkdrawf) only resolve paths correctly relative to the working
 * directory. Where the handler sets an `encodeOutputSuffix` (e.g. ",aff" for
 * riscos-mkdrawf, which always appends it to whatever output name it is given,
 * so passing ",aff" straight through would produce "name,aff,aff"), that
 * suffix is stripped before invoking and the file the command actually
 * produces is renamed to match the chosen destination exactly.
 */
export async function runEncode(options: EncodeOptions): Promise<EncodeResult> {
	const { text, encodeCmd, encodeOutputSuffix, destPath, env } = options;

	const destDir = path.dirname(destPath) || '.';
	const destName = path.basename(destPath);
	const outputArg =
		encodeOutputSuffix && destName.endsWith(encodeOutputSuffix)
			? destName.slice(0, -encodeOutputSuffix.length)
			: destName;
	const producedPath = path.join(destDir, outputArg + encodeOutputSuffix);
	const inputName = `.fileconverter-input-${randomUUID().replace(/-/g, '')}.tmp`;
	const inputPath = path.join(destDir, inputName);

	let stderr = '';
	let exitCode: number | null;
	try {
		await fs.writeFile(inputPath, text, 'utf8');
		const argv = buildArgv(encodeCmd, { '${input}': inputName, '${output}': outputArg });
		({ exitCode, stderr } = await run(argv, destDir, env));
	} catch (e) {
		return { ok: false, message: `failed to launch encode command:\n${message(e)}` };
	} finally {
		await fs.rm(inputPath, { force: true }).catch(() => {});
	}

	if (exitCode === null) {
		return { ok: false, message: `failed to launch encode command:\n${stderr}` };
	}
	if (exitCode !== 0) {
		return { ok: false, message: `encode command exited with status ${exitCode}:\n${stderr}` };
	}

	try {
		await fs.access(producedPath);
	} catch {
		return {
			ok: false,
			message: `encode command exited successfully but ${producedPath} was not created.`,
		};
	}

	try {
		if (path.resolve(producedPath) !== path.resolve(destPath)) {
			await fs.rename(producedPath, destPath);
		}
	} catch (e) {
		return {
			ok: false,
			message: `encoded ${producedPath} but failed to move it to ${destPath}:\n${message(e)}`,
		};
	}

	return { ok: true, path: destPath };
}

function run(
	argv: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), {
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stderrChunks: Buffer[] = [];
		let launchError: string | null = null;

		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		child.on('error', (e: Error) => {
			launchError = e.message;
		});
		child.on('close', (code) => {
			resolve(
				launchError !== null
					? { exitCode: null, stderr: launchError }
					: { exitCode: code, stderr: Buffer.concat(stderrChunks).toString('utf8') },
			);
		});
	});
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
