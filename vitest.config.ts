import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e/ is driven by Playwright against a real Chrome, not by Vitest.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
