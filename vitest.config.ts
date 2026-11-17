import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Nested git worktrees are full second checkouts; never collect their copy of the suite.
    exclude: [...configDefaults.exclude, '.worktrees/**', '.claude/worktrees/**'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
      // Global floors set just below current coverage to catch regressions and
      // ratchet upward over time. Raise these as the I/O layer gains tests.
      thresholds: {
        statements: 45,
        branches: 38,
        functions: 48,
        lines: 45,
      },
    },
  },
})
