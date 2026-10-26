import { Component, ChangeDetectorRef } from '@angular/core';
import { AuthService } from '../../shared/services/auth.service';
@Component({ selector: 'app-access', standalone: true, templateUrl: './access.component.html' })
export class AccessComponent {
  busy = false;
  constructor(public auth: AuthService, private cdr: ChangeDetectorRef) {}
  async logout() { if (this.busy) return; this.busy = true; this.cdr.detectChanges(); await this.auth.logout(); this.busy = false; }
}
