import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // `ui/tests` kept separate from `tests/` deliberately -- ui/src is
    // browser-targeted code (its own tsconfig.ui.json, DOM lib), and
    // keeping its tests physically outside `tests/**` means the backend
    // `tsconfig.json`'s `npx tsc --noEmit` (which includes `tests/**/*.ts`)
    // never has a reason to pull in a DOM-typed file transitively.
    include: ['tests/**/*.test.ts', 'ui/tests/**/*.test.ts'],
  },
});
