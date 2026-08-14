import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildArgv,
	buildEnv,
	canEncode,
	compileHandlers,
	findHandler,
	findHandlerById,
	isReadOnly,
	type HandlerConfig,
} from '../src/handlers.js';

test('buildArgv substitutes known tokens only', () => {
	const argv = buildArgv(['tool', '${file}', '--flag', '${output}', 'literal'], {
		'${file}': 'in.txt',
		'${output}': 'out.txt',
	});
	assert.deepEqual(argv, ['tool', 'in.txt', '--flag', 'out.txt', 'literal']);
});

test('buildEnv merges process env, then global, then handler', () => {
	const env = buildEnv(
		{ FILECONVERTER_BASE: 'from-process-env' },
		{ A: 'global', B: 'global' },
		{ B: 'handler' },
	);
	assert.equal(env.FILECONVERTER_BASE, 'from-process-env');
	assert.equal(env.A, 'global');
	assert.equal(env.B, 'handler', 'handler env overrides the global setting');
});

const CONFIGS: HandlerConfig[] = [
	{
		id: 'a',
		match: ['.*(\\\\|/)*,ff8$', '.*(\\\\|/)*,ffc$'],
		decode_cmd: ['tool_a', '${file}'],
		encode_cmd: null,
	},
	{
		id: 'b',
		match: ['.*(\\\\|/)*,aff$'],
		decode_cmd: ['tool_b', '${file}'],
		encode_cmd: ['tool_b', '${input}', '${output}'],
	},
];

test('findHandler matches configured patterns', () => {
	const handlers = compileHandlers(CONFIGS);
	assert.equal(findHandler(handlers, '/some/dir/Module,ff8')?.id, 'a');
	assert.equal(findHandler(handlers, '/some/dir/Thing,ffc')?.id, 'a');
	assert.equal(findHandler(handlers, '/some/dir/Drawing,aff')?.id, 'b');
	assert.equal(findHandler(handlers, '/some/dir/Unrelated.txt'), null);
	assert.equal(findHandler(handlers, null), null);
	assert.equal(findHandlerById(handlers, 'b')?.id, 'b');
	assert.equal(findHandlerById(handlers, 'missing'), null);
});

test('compileHandlers defaults the optional fields', () => {
	const [handler] = compileHandlers([{ id: 'x', match: ['\\.bin$'], decode_cmd: ['xxd'] }]);
	assert.equal(handler.decodeMode, 'stdout');
	assert.equal(handler.language, null);
	assert.equal(handler.encodeCmd, null);
	assert.equal(handler.encodeOutputSuffix, '');
	assert.deepEqual(handler.env, {});
});

test('compileHandlers skips a handler with an invalid pattern rather than throwing', () => {
	const errors: string[] = [];
	const handlers = compileHandlers(
		[
			{ id: 'broken', match: ['*not-a-regex('], decode_cmd: ['tool'] },
			{ id: 'fine', match: ['\\.bin$'], decode_cmd: ['xxd'] },
		],
		(message) => errors.push(message),
	);
	assert.deepEqual(
		handlers.map((h) => h.id),
		['fine'],
		'one bad pattern must not take the whole table down',
	);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /broken/);
});

test('a handler with no encode command produces a read-only document', () => {
	const handlers = compileHandlers(CONFIGS);
	assert.equal(isReadOnly(findHandlerById(handlers, 'a')!), true);
	assert.equal(isReadOnly(findHandlerById(handlers, 'b')!), false, 'reversible formats stay editable');
});

test('a failed decode disables the encode command', () => {
	const handlers = compileHandlers(CONFIGS);
	const reversible = findHandlerById(handlers, 'b')!;
	assert.equal(canEncode(reversible, false), true);
	assert.equal(canEncode(reversible, true), false, 'nothing safe to encode back from a failed decode');
	assert.equal(canEncode(findHandlerById(handlers, 'a'), false), false);
	assert.equal(canEncode(null, false), false);
});
