import { defineConfig } from 'vitest/config';

// Note: the run prints a "Sourcemap ... points to missing source files" line per n8n-workflow file.
// That is n8n-workflow's own packaging and does not affect results.
export default defineConfig({
	test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
