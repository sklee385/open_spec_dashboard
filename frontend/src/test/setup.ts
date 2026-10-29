import '@testing-library/jest-dom'
import { beforeEach, vi } from 'vitest'

// Unmount flushes recovery drafts after test-local teardown; each test starts fresh.
beforeEach(() => { localStorage.clear(); })

// Mock window.matchMedia for components that use useMediaQuery
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})
