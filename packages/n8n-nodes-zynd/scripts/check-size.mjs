// M3.8: the size and dependency budget for the package, from `npm pack --dry-run --json`.
// Run after `npm run build`. Fails if the unpacked size passes 50 KB or any runtime dependency appears.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_UNPACKED = 50 * 1024;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));

const problems = [];
if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push(`runtime dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
if (pkg.license !== 'MIT') problems.push(`license is ${pkg.license}`);
if (!pkg.keywords?.includes('n8n-community-node-package')) problems.push('missing keyword n8n-community-node-package');
if (!pkg.peerDependencies?.['n8n-workflow']) problems.push('missing peer dependency n8n-workflow');
if (pack.unpackedSize > MAX_UNPACKED) problems.push(`unpacked size ${pack.unpackedSize} B is over ${MAX_UNPACKED} B`);
if (!pack.files.some((f) => f.path === 'dist/nodes/Zynd/Zynd.node.js')) problems.push('dist is missing: run npm run build first');

console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files, ${(pack.size / 1024).toFixed(1)} KB packed, ${(pack.unpackedSize / 1024).toFixed(1)} KB unpacked (limit 50 KB), ${Object.keys(pkg.dependencies ?? {}).length} dependencies`);
if (problems.length) {
	console.error(`FAILED:\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
