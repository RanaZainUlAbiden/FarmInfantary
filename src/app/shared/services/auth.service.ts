import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import { FlockService } from './flock.service';
import { FarmUnitService } from './farm-unit.service';
import { PendingStateService } from './pending-state.service';
import { HttpPlatformApi } from '../platform/http-platform-api';

export interface SessionUser {
  userId: number; username: string; role: 'super_admin' | 'farm_admin' | 'staff'; farmId: number | null;
  farm: { farm_id: number; farm_name: string; business_type: string } | null;
}
const businessTypes = ['broiler_distribution', 'layer_distribution', 'all', 'broiler', 'layer', 'distribution'];
export function safeReturnUrl(value: unknown): string {
  return typeof value === 'string' && /^(?:\/app(?:\/|\?|$)|\/team(?:\?|$))/.test(value) && !/[\\\u0000-\u001f]/.test(value) ? value : '/app';
}

/** Only server cookie responses establish identity. Storage is UI cache only. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private user: SessionUser | null = null;
  private epoch = 0;
  private initialized = false;
  private restoring: Promise<void> | null = null;
  private signingOut: Promise<{ success: boolean; error?: string }> | null = null;
  private signingIn = false;
  message = '';
  get sessionEpoch(): number { return this.epoch; }
  get logoutPending(): boolean { return sessionStorage.getItem('fi_logout_pending') === '1'; }

  constructor(private http: HttpClient, private router: Router, private flocks: FlockService,
    private units: FarmUnitService, private pending: PendingStateService, private platform: HttpPlatformApi) {
    localStorage.removeItem('currentFarm'); localStorage.removeItem('businessType');
    window.addEventListener('storage', event => {
      if (event.key === 'fi_auth_event') this.invalidate('Your sign-in changed in another tab. Sign in again.');
    });
  }
  private validUser(value: any): value is SessionUser {
    if (!value || !Number.isSafeInteger(value.userId) || value.userId < 1 || typeof value.username !== 'string') return false;
    if (value.role === 'super_admin') return value.farmId === null && value.farm === null;
    return ['farm_admin', 'staff'].includes(value.role) && Number.isSafeInteger(value.farmId) && value.farmId > 0 &&
      value.farm?.farm_id === value.farmId && typeof value.farm.farm_name === 'string' && businessTypes.includes(value.farm.business_type);
  }
  private resetAccountState() {
    this.platform.resetSession(); this.flocks.reset(); this.units.reset(); this.pending.clearAll();
    for (const key of ['currentFarm', 'businessType', 'currentFlock', 'currentUnit', 'lastBroilerFlockId',
      'lastLayerBatchId', 'lastBroilerUnitId', 'lastLayerUnitId', 'activeBusinessTab', 'lastRouteByTab']) localStorage.removeItem(key);
  }
  private adopt(value: SessionUser) {
    const owner = `${value.userId}:${value.farmId ?? 'platform'}:${value.role}`;
    // This cache owner can discard preferences; it can never establish identity.
    if (sessionStorage.getItem('fi_ui_owner') !== owner || this.user !== null && this.user.userId !== value.userId) this.resetAccountState();
    sessionStorage.setItem('fi_ui_owner', owner);
    this.user = { userId: value.userId, username: value.username, role: value.role, farmId: value.farmId, farm: value.farm ? { ...value.farm } : null };
    this.epoch++; this.initialized = true; this.message = '';
  }
  private clearIdentity(message = '') {
    this.user = null; this.epoch++; this.initialized = true; this.message = message;
    this.resetAccountState(); sessionStorage.removeItem('fi_ui_owner');
  }
  private broadcast() { localStorage.setItem('fi_auth_event', crypto.randomUUID()); }

  async initialize(force = false): Promise<void> {
    if (this.restoring) return this.restoring;
    if (!force && this.initialized && !this.logoutPending) return;
    const work = async () => {
      if (this.logoutPending) { await this.logout(false); return; }
      const epoch = this.epoch;
      try {
        const result = await firstValueFrom(this.http.get<{ success: boolean; user: SessionUser }>('/api/auth/me').pipe(timeout(10_000)));
        if (epoch !== this.epoch) return;
        if (result.success && this.validUser(result.user)) this.adopt(result.user);
        else this.clearIdentity('Your account details could not be loaded. Try again.');
      } catch (error: any) {
        if (epoch !== this.epoch) return;
        this.clearIdentity(error?.status === 401 ? '' : 'Could not check your sign-in. Check your connection and try again.');
      }
    };
    this.restoring = work().finally(() => { this.restoring = null; }); return this.restoring;
  }
  async login(username: string, password: string): Promise<boolean> {
    if (this.signingIn || this.signingOut || this.logoutPending) return false;
    this.signingIn = true; this.clearIdentity(); const epoch = this.epoch;
    try {
      const result = await firstValueFrom(this.http.post<{ success: boolean; user: SessionUser }>('/api/auth/login',
        { username: username.trim(), password }).pipe(timeout(15_000)));
      if (epoch !== this.epoch) return false;
      if (!result.success || !this.validUser(result.user)) { this.message = 'Your account details could not be loaded. Try again.'; return false; }
      this.adopt(result.user); this.broadcast(); return true;
    } catch (error: any) {
      if (epoch === this.epoch) this.message = error?.status === 401 ? 'Invalid username or password.' : error?.status === 429
        ? 'Too many sign-in attempts. Try again later.' : 'Could not sign in. Check your connection and try again.';
      return false;
    } finally { this.signingIn = false; }
  }
  logout(navigate = true): Promise<{ success: boolean; error?: string }> {
    if (this.signingOut) return this.signingOut;
    sessionStorage.setItem('fi_logout_pending', '1'); this.clearIdentity(); this.broadcast();
    const work = async () => {
      try {
        const response=firstValueFrom(this.http.post('/api/auth/logout', {}).pipe(timeout(10_000)));
        if(navigate)void this.router.navigate(['/login'],{replaceUrl:true});
        await response;
        sessionStorage.removeItem('fi_logout_pending'); return { success: true };
      } catch {
        this.message = 'Sign-out could not be confirmed. Check your connection and retry sign-out.';
        return { success: false, error: this.message };
      }
    };
    this.signingOut = work().finally(() => { this.signingOut = null; }); return this.signingOut;
  }
  invalidate(message = 'Your session ended. Sign in again.', expectedEpoch = this.epoch) {
    if (expectedEpoch !== this.epoch) return;
    const returnUrl = safeReturnUrl(this.router.url); this.clearIdentity(message);
    if (/^\/(app|access|admin|team)(?:\/|\?|$)/.test(this.router.url)) {
      void this.router.navigate(['/login'], { replaceUrl: true, queryParams: { returnUrl } });
    }
  }
  // Compatibility for older callers; module assignment belongs to platform administration.
  async updateBusinessType(_farmId: number, _businessType: string): Promise<any> {
    return { success: false, error: 'Only a super administrator can assign account modules.' };
  }
  getCurrentUser(): SessionUser | null { return this.user ? { ...this.user, farm: this.user.farm ? { ...this.user.farm } : null } : null; }
  getCurrentFarm(): any { return this.user?.farm ? { ...this.user.farm } : null; }
  isLoggedIn(): boolean { return this.user !== null; }
  canUseBusinessApp(): boolean { return this.user?.role === 'farm_admin' && this.user.farm !== null; }
  landingUrl(returnUrl: unknown = '/app'): string { return this.user?.role==='super_admin'?'/admin':this.canUseBusinessApp() ? safeReturnUrl(returnUrl) : '/access'; }
}
