import { defineConfig } from 'vitest/config'

// Exercise the published DSH prerelease packages rather than a neighboring
// Harness checkout, because this bundle is installed from its own repository.
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Runtime-state tests temporarily own process-wide env / pending-queue dirs;
    // serial files keep their isolation independent of Vitest's worker model.
    fileParallelism: false,
  },
})
