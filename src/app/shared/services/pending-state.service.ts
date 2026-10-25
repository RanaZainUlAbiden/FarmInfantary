import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class PendingStateService {
  private readonly PREFIX = 'pending_state_';

  constructor() {
    // Restore in-memory cache from sessionStorage on init
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(this.PREFIX)) {
        try {
          const value = sessionStorage.getItem(key);
          if (value) {
            this.cache.set(key.replace(this.PREFIX, ''), JSON.parse(value));
          }
        } catch {}
      }
    }
  }

  private cache = new Map<string, any>();

  saveState(componentName: string, state: any) {
    this.cache.set(componentName, state);
    try {
      sessionStorage.setItem(this.PREFIX + componentName, JSON.stringify(state));
    } catch {
      // Silently fail if storage is full
    }
  }

  getState(componentName: string): any {
    if (this.cache.has(componentName)) {
      return this.cache.get(componentName);
    }
    // Fallback: try sessionStorage directly
    try {
      const stored = sessionStorage.getItem(this.PREFIX + componentName);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.cache.set(componentName, parsed);
        return parsed;
      }
    } catch {}
    return undefined;
  }

  clearState(componentName: string) {
    this.cache.delete(componentName);
    sessionStorage.removeItem(this.PREFIX + componentName);
  }

  clearAll() {
    this.cache.clear();
    // Remove only our keys
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(this.PREFIX)) {
        sessionStorage.removeItem(key);
      }
    }
  }
}
