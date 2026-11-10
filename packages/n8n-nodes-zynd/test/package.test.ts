/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals -- tests are not part of the published package */
// M0.7 / M3.8 / M3.9: what ships must stay a pure HTTP client with nothing sensitive in it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function sources(dir: string): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
	);
}
const shipped = [...sources('credentials'), ...sources('nodes')];

describe('package.json', () => {
	it('is a community node package with no runtime dependencies', () => {
		expect(pkg.name).toBe('n8n-nodes-zynd');
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.license).toBe('MIT');
		expect(pkg.dependencies).toBeUndefined();
		expect(pkg.peerDependencies).toEqual({ 'n8n-workflow': '*' });
		expect(pkg.files).toEqual(['dist']);
		expect(pkg.n8n.strict).toBe(true);
	});

	it('points npm and provenance at its folder in the monorepo', () => {
		expect(pkg.repository.directory).toBe('packages/n8n-nodes-zynd');
	});

	it('lists a source file for every credential and node it ships', () => {
		for (const dist of [...pkg.n8n.credentials, ...pkg.n8n.nodes] as string[]) {
			expect(existsSync(join(root, dist.replace(/^dist\//, '').replace(/\.js$/, '.ts'))), dist).toBe(true);
		}
		expect(pkg.n8n.nodes).toEqual(['dist/nodes/Zynd/Zynd.node.js', 'dist/nodes/Zynd/ZyndTrigger.node.js']);
	});
});

describe('shipped source', () => {
	it('found the files', () => expect(shipped.length).toBeGreaterThanOrEqual(4));

	it('imports only n8n-workflow and its own files', () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), 'utf8');
			for (const m of text.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
				expect(m[1]!.startsWith('.') || m[1] === 'n8n-workflow', `${file} imports ${m[1]}`).toBe(true);
			}
		}
	});

	it('does not use console, process, require, Buffer, eval or fetch', () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			for (const banned of [/\bconsole\./, /\bprocess\./, /\brequire\(/, /\bBuffer\b/, /\beval\(/, /\bnew Function\b/, /\bfetch\(/]) {
				expect(text, `${file} matches ${banned}`).not.toMatch(banned);
			}
		}
	});

	it('mentions no signing material', () => {
		for (const file of shipped) {
			const text = readFileSync(join(root, file), 'utf8').toLowerCase();
			for (const word of ['privatekey', 'private key', 'private_key', 'mnemonic', 'seed phrase', 'secretkey', 'ed25519', 'derivation']) {
				expect(text, `${file} mentions ${word}`).not.toContain(word);
			}
		}
	});
});
