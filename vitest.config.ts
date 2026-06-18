import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // version.ts excluded: it is only a constant.
      exclude: ['src/version.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        // Tightened after the coverage-stress pass. Headroom of ~2 points
        // each so deleting one stress test doesn't auto-fail the gate.
        statements: 95,
        branches: 85,
        functions: 100,
        lines: 95,
      },
    },
  },
})
