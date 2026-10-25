import { Injectable } from '@angular/core';

export interface FormState {
  [key: string]: any;
}

@Injectable({
  providedIn: 'root'
})
export class FormStateService {
  // 🔥 Use localStorage for persistence across navigation
  private readonly STORAGE_KEY = 'farm_form_states';
  private readonly SESSION_KEY = 'farm_form_session';

  constructor() {
    // Track session start
    if (!localStorage.getItem(this.SESSION_KEY)) {
      localStorage.setItem(this.SESSION_KEY, Date.now().toString());
    }
  }

  // ── SAVE STATE ─────────────────────────────────────────────

  saveState(formName: string, data: any): void {
    try {
      const allStates = this.getAllStates();
      allStates[formName] = {
        data: data,
        timestamp: Date.now(),
        sessionId: localStorage.getItem(this.SESSION_KEY)
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(allStates));
      console.log(`💾 State saved for "${formName}"`);
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }

  // ── GET STATE ──────────────────────────────────────────────

  getState(formName: string): any {
    try {
      const allStates = this.getAllStates();
      const state = allStates[formName];
      if (state) {
        const currentSession = localStorage.getItem(this.SESSION_KEY);
        if (state.sessionId === currentSession) {
          console.log(`📂 State loaded for "${formName}"`);
          return state.data;
        } else {
          this.clearState(formName);
          return null;
        }
      }
      return null;
    } catch (error) {
      console.error('Failed to get state:', error);
      return null;
    }
  }

  // ── CLEAR STATE ────────────────────────────────────────────

  clearState(formName: string): void {
    try {
      const allStates = this.getAllStates();
      delete allStates[formName];
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(allStates));
      console.log(`🗑️ State cleared for "${formName}"`);
    } catch (error) {
      console.error('Failed to clear state:', error);
    }
  }

  // ── CLEAR ALL STATES ──────────────────────────────────────

  clearAllStates(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
      console.log('🗑️ All states cleared');
    } catch (error) {
      console.error('Failed to clear all states:', error);
    }
  }

  // ── GET ALL STATES ─────────────────────────────────────────

  private getAllStates(): any {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  }

  // ── HAS STATE ──────────────────────────────────────────────

  hasState(formName: string): boolean {
    return !!this.getState(formName);
  }

  // ── IS STATE STALE ─────────────────────────────────────────

  isStateStale(formName: string, maxAgeMinutes: number = 60): boolean {
    try {
      const allStates = this.getAllStates();
      const state = allStates[formName];
      if (!state) return true;
      const age = (Date.now() - state.timestamp) / (1000 * 60);
      return age > maxAgeMinutes;
    } catch {
      return true;
    }
  }

  // ── GET STATE WITH TIMESTAMP ──────────────────────────────

  getStateWithTimestamp(formName: string): { data: any; timestamp: number } | null {
    try {
      const allStates = this.getAllStates();
      const state = allStates[formName];
      if (state) {
        return { data: state.data, timestamp: state.timestamp };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── GET ALL FORM NAMES ─────────────────────────────────────

  getFormNames(): string[] {
    try {
      const allStates = this.getAllStates();
      return Object.keys(allStates);
    } catch {
      return [];
    }
  }

  // ── CLEAR STALE STATES ─────────────────────────────────────

  clearStaleStates(maxAgeMinutes: number = 60): void {
    try {
      const allStates = this.getAllStates();
      const currentSession = localStorage.getItem(this.SESSION_KEY);
      let changed = false;
      
      for (const key of Object.keys(allStates)) {
        const state = allStates[key];
        const age = (Date.now() - state.timestamp) / (1000 * 60);
        if (age > maxAgeMinutes || state.sessionId !== currentSession) {
          delete allStates[key];
          changed = true;
        }
      }
      
      if (changed) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(allStates));
      }
    } catch (error) {
      console.error('Failed to clear stale states:', error);
    }
  }
}