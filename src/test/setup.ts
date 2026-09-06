import { configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const canvasContext = {
  drawImage: () => {},
  fillRect: () => {},
  fillText: () => {},
  putImageData: () => {},
  scale: () => {},
  translate: () => {},
};

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => canvasContext,
});
Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
  configurable: true,
  value: () => 'data:image/png;base64,iVBORw0KGgo=',
});
Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  configurable: true,
  value(callback: BlobCallback) {
    callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
  },
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: ResizeObserverMock,
});

// jsdom does not implement matchMedia; provide a minimal stub for the mobile hook.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!window.localStorage) {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

// App's overlays and the author tools are React.lazy, so findBy* queries wait on a
// dynamic import rather than on a render. Testing Library's 1 s default is enough when a
// file runs alone but not when 140-odd test files share the CPU, which made those queries
// fail as a function of machine load rather than of behaviour. The worst of them — the
// World Editor, which pulls three.js in behind it — takes ~3 s unloaded, so 15 s is the
// headroom that keeps it a behaviour check rather than a race against the scheduler. It
// stays well under the testTimeout in vitest.config.ts, so a query that really never
// resolves still fails by naming the element it could not find.
configure({ asyncUtilTimeout: 15_000 });
