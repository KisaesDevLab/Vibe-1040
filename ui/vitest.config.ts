import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Component tests for the review UI.
 *
 * Deliberately few and deliberately about one thing: **the claims this app makes in words**.
 * Every UI defect found this session was found by rendering in a browser, not by a test, and
 * that will stay true of layout — a test cannot see a label breaking one word per line. What a
 * test can hold is the part that is not layout at all: that a blank money box stays blank
 * rather than becoming a zero, that "not stated" is offered and selected, that an override
 * announces the document it will displace before it is typed over, and that a panel refuses to
 * offer a control it cannot honour.
 *
 * Those are §5, §9 and P18's override contract, asserted on the surface a preparer actually
 * touches rather than one layer below it.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
