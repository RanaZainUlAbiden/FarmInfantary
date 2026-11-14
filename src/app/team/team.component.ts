import { Component, OnInit, OnDestroy, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminApi } from '../admin/admin-api.service';
import { PasswordFieldComponent } from '../shared/components/password-field/password-field.component';

/**
 * Staff & security for a farm owner, shown inside the app (sidebar, module tabs
 * and header stay in place) instead of on a separate page.
 *
 * Staff accounts: the platform administrator decides how many the farm may have
 * (`staff_seat_limit`). The database enforces it, so this screen only explains it
 * clearly and stops offering the form once every account is used.
 */
@Component({
  selector: 'app-team',
  standalone: true,
  imports: [CommonModule, FormsModule, PasswordFieldComponent],
  templateUrl: './team.component.html',
  styleUrl: './team.component.scss'
})
export class TeamComponent implements OnInit, OnDestroy {
  private api = inject(AdminApi);
  private cdr = inject(ChangeDetectorRef);
  private destroyed = false;

  loading = true;
  busy = false;
  error = '';
  message = '';
  farm: any = null;
  users: any[] = [];
  more = false;

  staffName = '';
  staffPassword = '';
  currentPassword = '';
  newDeleteCode = '';
  deleteConfigured = false;
  invalid = new Set<string>();

  get limit(): number { return Number(this.farm?.staff_seat_limit ?? 0); }
  get used(): number { return Number(this.farm?.active_staff ?? 0); }
  get remaining(): number { return Math.max(0, this.limit - this.used); }
  get percent(): number { return this.limit > 0 ? Math.min(100, Math.round((this.used / this.limit) * 100)) : 0; }
  get canCreate(): boolean { return this.limit > 0 && this.remaining > 0 && this.farm?.status === 'active'; }
  get staffList(): any[] { return this.users.filter(u => u.role === 'staff'); }

  async ngOnInit() { await this.load(); }
  ngOnDestroy() { this.destroyed = true; this.staffPassword = this.currentPassword = this.newDeleteCode = ''; }

  private render() { if (!this.destroyed) this.cdr.detectChanges(); }

  private async read(path: string) {
    const r = await this.api.request('GET', path);
    if (!r.success) throw new Error(r.error);
    return r;
  }

  private async run(work: () => Promise<void>, success = '') {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.message = ''; this.render();
    try { await work(); this.message = success; }
    catch (e: any) { this.error = e?.message || 'Could not complete the request.'; }
    finally { this.busy = false; this.render(); }
  }

  async load() {
    this.loading = true; this.error = '';
    try {
      const team = await this.read('/api/account/staff');
      this.farm = team.farm; this.users = team.users; this.more = team.users.length === 50;
      this.deleteConfigured = (await this.read('/api/account/delete-code')).configured;
    } catch (e: any) { this.error = e?.message || 'Could not load your team.'; }
    this.loading = false; this.render();
  }

  private validName(v: string) { return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(v.trim()); }
  private validPassword(v: string) { const n = [...v].length; return n >= 1 && n <= 128; }

  private check(checks: Array<[string, boolean, string]>): boolean {
    this.invalid = new Set(checks.filter(([, ok]) => !ok).map(([id]) => id));
    const bad = checks.find(([, ok]) => !ok);
    if (bad) { this.error = bad[2]; this.message = ''; this.render(); return false; }
    return true;
  }

  async createStaff() {
    if (!this.canCreate) return;
    if (!this.check([
      ['team-staff-name', this.validName(this.staffName), 'Enter a username of 3 to 64 letters, numbers, dots, underscores or hyphens.'],
      ['team-staff-password', this.validPassword(this.staffPassword), 'Use a password of 1 to 128 characters.']
    ])) return;
    await this.run(async () => {
      try {
        const r = await this.api.request('POST', '/api/account/staff', { username: this.staffName, password: this.staffPassword });
        if (!r.success) throw new Error(r.error);
        this.staffName = '';
      } finally { this.staffPassword = ''; }
      await this.reload();
    }, 'Staff account created.');
  }

  private async reload() {
    const team = await this.read('/api/account/staff');
    this.farm = team.farm; this.users = team.users; this.more = team.users.length === 50;
  }

  async loadMore() {
    await this.run(async () => {
      const r = await this.read('/api/account/staff?before=' + this.users.at(-1).user_id);
      this.users.push(...r.users); this.more = r.users.length === 50;
    });
  }

  async saveDeleteCode() {
    if (!this.check([
      ['team-current-password', !!this.currentPassword, 'Enter your current account password.'],
      ['team-delete-code', [...this.newDeleteCode].length >= 8 && [...this.newDeleteCode].length <= 128, 'Use a delete code of 8 to 128 characters.']
    ])) return;
    await this.run(async () => {
      try {
        const r = await this.api.request('PUT', '/api/account/delete-code', { currentPassword: this.currentPassword, newCode: this.newDeleteCode });
        if (!r.success) throw new Error(r.error);
        this.deleteConfigured = true;
      } finally { this.currentPassword = this.newDeleteCode = ''; }
    }, 'Delete code saved. Previous delete confirmations have expired.');
  }

  onEnter(event: Event) { if ((event as KeyboardEvent).isComposing) event.preventDefault(); }
}
