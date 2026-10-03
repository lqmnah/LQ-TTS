import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Files marked `@vitest-environment node` have no window.
  globalThis.window?.localStorage.clear();
});
