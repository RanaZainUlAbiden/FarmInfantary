import { Injectable, inject } from '@angular/core';

import { PLATFORM_API } from '../platform/platform.token';
import { PlatformApi } from '../platform/platform-api';
import { DatabaseService } from './database.service';
import { AuthService } from './auth.service';

const SETTING_KEY = 'delete_pin';
const DEFAULT_PIN = 'qwer@789';

// PHASE 3: this comparison must move SERVER-SIDE. Fetching the PIN to the
// browser and comparing it here was adequate on a desktop machine the owner
// controlled; on the web anyone can read it out of a network response or
// simply skip the check. It is a real control once staff accounts exist, not
// a speed bump. See docs/DECISIONS.md D7.

@Injectable({ providedIn: 'root' })
export class DeleteAuthService {
  private readonly platform: PlatformApi = inject(PLATFORM_API);

  constructor(private db: DatabaseService, private authService: AuthService) {}

  private getFarmId(): number | null {
    return this.authService.getCurrentFarm()?.farm_id || null;
  }

  async getPin(): Promise<string> {
    const farmId = this.getFarmId();
    if (!farmId) return DEFAULT_PIN;
    try {
      const result = await this.platform.getAppSetting(farmId, SETTING_KEY);
      return result?.value || DEFAULT_PIN;
    } catch {
      return DEFAULT_PIN;
    }
  }

  async setPin(newPin: string): Promise<boolean> {
    const farmId = this.getFarmId();
    if (!farmId || !newPin || !newPin.trim()) return false;
    try {
      const result = await this.platform.setAppSetting(farmId, SETTING_KEY, newPin.trim());
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