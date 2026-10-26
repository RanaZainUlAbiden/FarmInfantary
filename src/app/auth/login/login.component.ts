import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../shared/services/auth.service';
import { PasswordFieldComponent } from '../../shared/components/password-field/password-field.component';

@Component({ selector: 'app-login', standalone: true, imports: [CommonModule, FormsModule, PasswordFieldComponent],
  templateUrl: './login.component.html', styleUrl: './login.component.scss' })
export class LoginComponent implements OnInit, OnDestroy {
  username = ''; password = ''; errorMessage = ''; checking = true; busy = false; submitted = false;
  private destroyed = false;
  private render() { if (!this.destroyed) this.cdr.detectChanges(); }
  ngOnDestroy() { this.destroyed = true; this.password = ''; }
  @ViewChild('usernameInput') usernameInput?: ElementRef<HTMLInputElement>;
  @ViewChild(PasswordFieldComponent) passwordInput?: PasswordFieldComponent;
  constructor(public auth: AuthService, private router: Router, private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}
  get usernameInvalid() { return this.submitted && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(this.username.trim()); }
  get passwordInvalid() { return this.submitted && !this.password; }
  async ngOnInit() { await this.restore(); }
  async restore(force = false) {
    if (this.busy) return;
    this.checking = true; this.render();
    await this.auth.initialize(force);
    this.checking = false; this.errorMessage = this.auth.message;
    if (this.auth.isLoggedIn()) await this.router.navigateByUrl(this.auth.landingUrl(this.route.snapshot.queryParamMap.get('returnUrl')), { replaceUrl: true });
    this.render();
  }
  async onLogin() {
    if (this.busy || this.checking || this.auth.logoutPending) return;
    this.submitted = true;
    if (this.usernameInvalid || this.passwordInvalid) {
      this.errorMessage = 'Enter your username and password.';
      if (this.usernameInvalid) this.usernameInput?.nativeElement.focus(); else this.passwordInput?.focus();
      this.render();
      return;
    }
    this.busy = true; this.errorMessage = ''; this.render();
    try {
      if (await this.auth.login(this.username, this.password)) {
        await this.router.navigateByUrl(this.auth.landingUrl(this.route.snapshot.queryParamMap.get('returnUrl')), { replaceUrl: true });
      } else { this.errorMessage = this.auth.message || 'Could not sign in. Try again.'; }
    } finally { this.password = ''; this.busy = false; this.submitted = false; this.render(); }
  }
  async retryLogout() {
    if (this.busy) return; this.busy = true; this.render();
    await this.auth.logout(false); this.errorMessage = this.auth.message; this.busy = false; this.render();
  }
  onEnter(event: Event) { if ((event as KeyboardEvent).isComposing) event.preventDefault(); }
}
