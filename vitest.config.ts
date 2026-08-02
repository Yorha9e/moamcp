import { defineConfig } from 'vitest/config';

// Test files run serially (fileParallelism: false) to deflake a pre-existing
// port-walk TOCTOU race: bus.test.ts and reuse.test.ts each start a Bus that
// walks ports from base+1, and when the two files execute in parallel they
// contend for the same ports (one test's successful bind is the other's
// EADDRINUSE, nondeterministically). Adding test files shifts vitest's
// scheduling and exposes the race more often, so we trade suite wall-time for
// determinism until the port walkers are made collision-free.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
