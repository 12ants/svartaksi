export interface WritableBrowserFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserFileHandle {
  getFile?(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<WritableBrowserFile>;
}

export interface BrowserDirectoryHandle {
  getFileHandle(name: string, options: { create: true }): Promise<BrowserFileHandle>;
}

export interface BrowserFiles {
  pickDirectory?: () => Promise<BrowserDirectoryHandle>;
  pickOpenFile?: () => Promise<BrowserFileHandle>;
  pickSaveFile?: (suggestedName: string) => Promise<BrowserFileHandle>;
  download(blob: Blob, filename: string): void;
}

export function browserFiles(): BrowserFiles {
  const picker = (window as typeof window & {
    showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
    showOpenFilePicker?: (options: object) => Promise<BrowserFileHandle[]>;
    showSaveFilePicker?: (options: object) => Promise<BrowserFileHandle>;
  }).showDirectoryPicker;
  const fileWindow = window as typeof window & {
    showOpenFilePicker?: (options: object) => Promise<BrowserFileHandle[]>;
    showSaveFilePicker?: (options: object) => Promise<BrowserFileHandle>;
  };
  return {
    pickDirectory: picker?.bind(window),
    pickOpenFile: fileWindow.showOpenFilePicker
      ? async () => (await fileWindow.showOpenFilePicker!({ types: storyFileTypes }))[0]
      : pickOpenFileWithInput,
    pickSaveFile: fileWindow.showSaveFilePicker
      ? (suggestedName) => fileWindow.showSaveFilePicker!({ suggestedName, types: storyFileTypes })
      : undefined,
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
}

function pickOpenFileWithInput(): Promise<BrowserFileHandle> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { reject(new DOMException('cancelled', 'AbortError')); return; }
      resolve({ getFile: async () => file, createWritable: async () => { throw new Error('The opened file is read-only'); } });
    }, { once: true });
    input.click();
  });
}

const storyFileTypes = [{
  description: 'Svartaksi story project',
  accept: { 'application/json': ['.json'] },
}];
