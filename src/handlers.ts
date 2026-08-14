/**
 * Handler table: which external command decodes which files.
 *
 * Deliberately free of any `vscode` import, so it can be unit tested in
 * plain Node without the editor host (see tests/).
 */

/** A handler exactly as it appears in the `fileconverter.handlers` setting. */
export interface HandlerConfig {
	id?: string;
	match?: string[];
	decode_cmd?: string[] | null;
	decode_mode?: string | null;
	language?: string | null;
	encode_cmd?: string[] | null;
	encode_output_suffix?: string | null;
	env?: Record<string, string> | null;
}

/** A handler with its patterns compiled and its optional fields defaulted. */
export interface Handler {
	id: string;
	patterns: RegExp[];
	decodeCmd: string[] | null;
	decodeMode: 'stdout' | 'file';
	language: string | null;
	encodeCmd: string[] | null;
	encodeOutputSuffix: string;
	env: Record<string, string>;
}

/**
 * Compiles the raw setting into matchable handlers. A handler whose `match`
 * contains an invalid regex is skipped rather than thrown over, so one bad
 * pattern in a user's settings can't take the whole table down with it; the
 * offending pattern is reported through onError for the caller to surface.
 */
export function compileHandlers(
	configs: HandlerConfig[],
	onError?: (message: string) => void,
): Handler[] {
	const handlers: Handler[] = [];
	for (const config of configs ?? []) {
		const patterns: RegExp[] = [];
		let broken = false;
		for (const pattern of config.match ?? []) {
			try {
				patterns.push(new RegExp(pattern));
			} catch (e) {
				broken = true;
				onError?.(
					`handler "${config.id ?? '?'}" has an invalid match pattern ${JSON.stringify(pattern)}: ${
						e instanceof Error ? e.message : String(e)
					}`,
				);
			}
		}
		if (broken) {
			continue;
		}
		handlers.push({
			id: config.id ?? '',
			patterns,
			decodeCmd: config.decode_cmd ?? null,
			decodeMode: config.decode_mode === 'file' ? 'file' : 'stdout',
			language: config.language ?? null,
			encodeCmd: config.encode_cmd ?? null,
			encodeOutputSuffix: config.encode_output_suffix ?? '',
			env: config.env ?? {},
		});
	}
	return handlers;
}

/** First handler with a pattern matching anywhere in `filePath`, or null. */
export function findHandler(handlers: Handler[], filePath: string | null | undefined): Handler | null {
	if (!filePath) {
		return null;
	}
	for (const handler of handlers) {
		for (const pattern of handler.patterns) {
			// Fresh lastIndex every time: a user-supplied pattern carrying the
			// /g flag would otherwise match only every other call.
			pattern.lastIndex = 0;
			if (pattern.test(filePath)) {
				return handler;
			}
		}
	}
	return null;
}

export function findHandlerById(handlers: Handler[], id: string | null | undefined): Handler | null {
	if (!id) {
		return null;
	}
	return handlers.find((handler) => handler.id === id) ?? null;
}

/**
 * Whether a decoded document should be locked. A format with no reverse
 * direction has nothing useful to do but be read; one with an `encode_cmd` is
 * left editable, since editing the decoded text and re-encoding it is the
 * whole point. Either way the document is never associated with the source
 * file's path, so neither can be saved back over the source.
 */
export function isReadOnly(handler: Handler): boolean {
	return !handler.encodeCmd || handler.encodeCmd.length === 0;
}

/** Whether "Re-encode As…" should be offered: the handler must have a reverse
 *  direction, and the decode it would be reversing must have succeeded. */
export function canEncode(handler: Handler | null, decodeFailed: boolean): boolean {
	return !!handler && !isReadOnly(handler) && !decodeFailed;
}

/**
 * Substitutes whole arguments only: an argv entry that is exactly a known
 * placeholder token (e.g. "${file}") is replaced, everything else is passed
 * through untouched. Substituting inside arguments would mean quoting rules,
 * and there is no shell here to need them.
 */
export function buildArgv(template: string[], substitutions: Record<string, string>): string[] {
	return template.map((arg) => (arg in substitutions ? substitutions[arg] : arg));
}

/**
 * Process environment, then the global `fileconverter.env` setting, then the
 * handler's own `env` on top.
 */
export function buildEnv(
	base: NodeJS.ProcessEnv,
	globalEnv: Record<string, string>,
	handlerEnv: Record<string, string>,
): NodeJS.ProcessEnv {
	return { ...base, ...globalEnv, ...handlerEnv };
}
