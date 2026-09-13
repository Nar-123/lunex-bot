import { vi } from 'vitest';
import type { Logger } from '../src/logger';

export function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    tail: vi.fn(() => []),
  };
}

export const identityMask = (text: string): string => text;
