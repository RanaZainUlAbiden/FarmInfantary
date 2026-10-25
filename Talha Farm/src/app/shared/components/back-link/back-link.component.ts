import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

/**
 * The "go up one level" button.
 *
 * Every drill-down screen under Account Ledger already had a back button at
 * its DETAIL level — out of one customer, one supplier, one bank account, back
 * to the list. None had one at the LIST level, so there was no way back to the
 * Account Ledger dashboard except clicking the sidebar item again, which is
 * what the client was doing.
 *
 * It is a component rather than five copies of an `<a>` because `.btn-back` is
 * styled separately in each of those screens' own stylesheets, and view
 * encapsulation means a child's markup cannot pick those up. One component
 * carries its own look, so the button is identical on every screen it appears
 * on, and a new drill-down screen gets it for a single line of template.
 *
 * `to` is an app-relative route segment, the same thing `layout.component.ts`
 * passes to `navigate()` — NOT a full path. It is always an absolute
 * navigation to `/app/<to>` rather than a history `back()`: history would
 * depend on how the user arrived, and a screen reached from the sidebar would
 * send them somewhere unrelated.
 */
@Component({
  selector: 'app-back-link',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button type="button" class="back-link" (click)="go()" [attr.aria-label]="'Back to ' + label">
      ← {{ label }}
    </button>
  `,
  styles: [`
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: #f1f5f9;
      color: #334155;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 0.35rem 0.7rem;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      margin-bottom: 0.5rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .back-link:hover { background: #e2e8f0; border-color: #94a3b8; }
  `]
})
export class BackLinkComponent {
  /** App-relative route segment to navigate to, e.g. `account-ledger`. */
  @Input() to = 'account-ledger';
  /** What the button says after the arrow. */
  @Input() label = 'Account Ledger';

  constructor(private router: Router) {}

  go() {
    this.router.navigate(['/app', this.to]);
  }
}
