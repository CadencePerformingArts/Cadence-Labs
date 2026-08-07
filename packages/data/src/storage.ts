/**
 * Minimal async key-value storage seam. The app injects AsyncStorage; tests
 * and non-RN environments get an in-memory fallback automatically.
 */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

class MemoryStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

let storage: KeyValueStorage = new MemoryStorage();

export function setStorage(impl: KeyValueStorage): void {
  storage = impl;
}

export function getStorage(): KeyValueStorage {
  return storage;
}
