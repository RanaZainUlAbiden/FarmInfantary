import { Injectable } from '@angular/core';

/**
 * Entitlement, replacing the desktop licence system.
 *
 * The desktop app enforced a per-MACHINE trial: a machine id from
 * `node-machine-id`, activation codes derived from it, an activation cycle
 * counter and clock-tamper detection. All of that is anti-piracy for software
 * installed on someone else's computer, and none of it means anything for a
 * web app served from a server we control.
 *
 * On the web, entitlement is a property of the ACCOUNT (docs/DECISIONS.md
 * D11): whether a farm is active, and whether its subscription is current.
 * That is a server-side question — a browser cannot be trusted to answer it —
 * so it will be enforced at the API, not here.
 *
 * Until then this reports "activated" so the layout's existing licence banner
 * renders as licensed. The CLASS AND ITS SIGNATURES ARE KEPT deliberately:
 * `layout.component.ts` reads this state in its template, and ripping it out
 * in Phase 2 would mean editing a template for no behavioural gain. Phase 5
 * replaces the body with a call to `GET /api/entitlement`.
 *
 * It does NOT grant anything. Nothing in the app gates access on this value;
 * the real control is the session and, from Phase 4, the permission check in
 * the SQL guard.
 */
@Injectable({
  providedIn: 'root'
})
export class LicenseService {
  async validateActivationKey(_key: string): Promise<boolean> {
    return true;
  }

  async startTrial(): Promise<void> {
    // No trials on the web: an account either exists or it does not.
  }

  async activate(_key: string): Promise<void> {
    // Activation is an account-level concern now.
  }

  async isActivated(): Promise<boolean> {
    return true;
  }

  async getLicenseDaysRemaining(): Promise<number> {
    return 0;
  }

  async getStatus(): Promise<{
    activated: boolean;
    isPermanent: boolean;
    trialExpired: boolean;
    daysRemaining: number;
    expiryDate: string | null;
    trialStarted: boolean;
    clockTampered: boolean;
    licenseDaysRemaining: number;
    activationCycle: number;
  }> {
    return {
      activated: true,
      isPermanent: true,
      trialExpired: false,
      daysRemaining: 0,
      expiryDate: null,
      trialStarted: true,
      clockTampered: false,
      licenseDaysRemaining: 0,
      activationCycle: 0
    };
  }

  async updateLastLaunchDate(): Promise<void> {
    // The desktop tracked this to detect a clock set backwards. A server knows
    // the time; a browser's clock is not evidence of anything.
  }

  async getTrialStatusMessage(): Promise<string> {
    return '';
  }
}
