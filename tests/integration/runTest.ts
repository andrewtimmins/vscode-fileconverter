/**
 * Downloads a VS Code build and runs tests/integration/index.ts inside a real
 * extension host. This is the only thing that exercises the parts of the port
 * that cannot run headlessly: intercepting the open, the virtual file system,
 * and read-only enforcement.
 */

import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
	// out/tests/integration -> repository root
	const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
	const extensionTestsPath = path.resolve(__dirname, './index.js');

	await runTests({
		extensionDevelopmentPath,
		extensionTestsPath,
		launchArgs: ['--disable-workspace-trust', '--disable-gpu', '--no-sandbox'],
	});
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
