import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LicenseService } from '../shared/services/license.service';

import { toLocalDateString } from '../shared/utils/date.util';
@Component({
  selector: 'app-activation',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './activation.component.html',
  styleUrl: './activation.component.scss'
})
export class ActivationComponent implements OnInit {
  activationKey: string = '';
  isLoading: boolean = false;
  errorMessage: string = '';
  isExpired: boolean = false;
  expirationDate: string = '';
  daysRemaining: number = 0;
  isTrialStarted: boolean = false;
  isActivated: boolean = false;
  isClockTampered: boolean = false;
  machineId: string = '';
  activationCycle: number = 0;

  constructor(
    private router: Router,
    private licenseService: LicenseService
  ) {}

  async ngOnInit() {
    this.licenseService.updateLastLaunchDate();
    try {
      this.machineId = await (window as any).electronAPI.getMachineId();
    } catch (e) {
      this.machineId = 'Unable to detect';
    }

    const status = await this.licenseService.getStatus();
    this.activationCycle = status.activationCycle || 0;

    if (status.clockTampered) {
      this.isClockTampered = true;
      return;
    }

    if (status.activated) {
      this.isActivated = true;
      this.router.navigate(['/login']);
      return;
    }

    if (status.trialStarted) {
      this.isTrialStarted = true;
      this.daysRemaining = status.daysRemaining;
      this.expirationDate = status.expiryDate || '';
      if (status.trialExpired) {
        this.isExpired = true;
        this.expirationDate = status.expiryDate || '';
      }
    } else {
      this.daysRemaining = 7;
    }
  }

  copyMachineId() {
    navigator.clipboard.writeText(this.machineId);
  }

  copyRenewalInfo() {
    navigator.clipboard.writeText(`${this.machineId} | Cycle: ${this.activationCycle}`);
  }

  async activate() {
    if (!this.activationKey.trim()) {
      this.errorMessage = 'Please enter an activation key';
      return;
    }
    this.isLoading = true;
    this.errorMessage = '';
    try {
      const isValid = await this.licenseService.validateActivationKey(this.activationKey);
      if (isValid) {
        this.licenseService.activate(this.activationKey);
        this.isActivated = true;
        setTimeout(() => {
          this.router.navigate(['/login']);
        }, 500);
      } else {
        this.errorMessage = '❌ Invalid activation key. Please contact support.';
      }
    } catch (error: any) {
      this.errorMessage = '❌ Activation failed: ' + error.message;
    } finally {
      this.isLoading = false;
    }
  }

  startTrial() {
    if (this.isTrialStarted) {
      this.router.navigate(['/login']);
      return;
    }
    this.licenseService.startTrial();
    this.isTrialStarted = true;
    this.daysRemaining = 7;
    this.expirationDate = toLocalDateString(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    setTimeout(() => {
      this.router.navigate(['/login']);
    }, 300);
  }

  getTodayDate(): string {
    return toLocalDateString();
  }
}