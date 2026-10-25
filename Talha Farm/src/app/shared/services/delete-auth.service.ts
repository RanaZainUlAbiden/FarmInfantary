import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { AuthService } from './auth.service';

const SETTING_KEY = 'delete_pin';
const DEFAULT_PIN = 'qwer@789';

@Injectable({ providedIn: 'root' })
export class DeleteAuthService {
  constructor(private db: DatabaseService, private authService: AuthService) {}

  private getFarmId(): number | null {
    return this.authService.getCurrentFarm()?.farm_id || null;
  }

  async getPin(): Promise<string> {
    const farmId = this.getFarmId();
    if (!farmId) return DEFAULT_PIN;
    try {
      const result = await (window as any).electronAPI.getAppSetting(farmId, SETTING_KEY);
      return result?.value || DEFAULT_PIN;
    } catch {
      return DEFAULT_PIN;
    }
  }

  async setPin(newPin: string): Promise<boolean> {
    const farmId = this.getFarmId();
    if (!farmId || !newPin || !newPin.trim()) return false;
    try {
      const result = await (window as any).electronAPI.setAppSetting(farmId, SETTING_KEY, newPin.trim());
      return !!result?.success;
    } catch {
      return false;
    }
  }

  async verifyCode(code: string): Promise<boolean> {
    const pin = await this.getPin();
    return !!code && code.trim() === pin;
  }
}