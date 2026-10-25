import { Component, Input, booleanAttribute } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BankSourceRow, isBankLabelled, bankNameOf, bankOptionLabel } from '../../utils/bank-source.util';

/**
 * The account dropdown that appears beside a Cash/Bank selector, and the
 * account name that appears in the saved row.
 *
 * Nine tables now record which bank account money moved through, across eight
 * screens with two or three rows each — a pending row, an edit row, a saved
 * row. One component rather than twenty copies of the same `*ngIf` and
 * `*ngFor`, so the empty-account and stale-account cases read the same way
 * everywhere.
 *
 * `row` is bound and MUTATED IN PLACE. That is deliberate: every one of these
 * screens already drives its pending and edit rows with `[(ngModel)]` straight
 * onto the row object, and `row` here is that same object reference. The
 * alternative — a value/valueChange pair per call site — would mean the parent
 * template naming the field twice at twenty sites, which is exactly where a
 * typo turns into a row saved against the wrong account.
 *
 * Which field says "bank" differs per screen (`payment_type` on the four that
 * already offered it, `payment_source` on income and purchase orders), so that
 * decision lives in `isBankLabelled()` and not here.
 */
@Component({
  selector: 'app-bank-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <ng-container *ngIf="visible">
      <!-- Saved row: the account's name, not a control. -->
      <span class="bank-name" *ngIf="readonly">{{ displayName }}</span>

      <ng-container *ngIf="!readonly">
        <!-- Nothing to choose from. Said here rather than left as an empty
             dropdown, because the save is refused until an account exists and
             the user would otherwise have no idea why. -->
        <span class="bank-missing" *ngIf="!banks?.length">No bank accounts</span>

        <select class="inline-input bank-select"
                *ngIf="banks?.length"
                [(ngModel)]="row.bank_id"
                [class.unset]="!row.bank_id"
                [attr.aria-label]="'Bank account'">
          <option [ngValue]="null">Select account…</option>
          <option *ngFor="let b of banks" [ngValue]="b.bank_id">{{ optionLabel(b) }}</option>
        </select>
      </ng-container>
    </ng-container>
  `,
  styles: [`
    .bank-select { min-width: 8rem; }
    /* An account still to be chosen is the one state that blocks the save, so
       it is marked rather than looking like any other untouched dropdown. */
    .bank-select.unset { border-color: #f59e0b; background: #fffbeb; }
    .bank-missing {
      font-size: 0.8rem;
      color: #b45309;
      white-space: nowrap;
    }
    .bank-name {
      font-size: 0.85rem;
      color: #475569;
    }
  `]
})
export class BankPickerComponent {
  /** The pending / edit / saved row. Mutated in place — see the class note. */
  @Input() row: BankSourceRow = {};

  /** The farm's own accounts, from `getHouseBankAccounts()`. Never a customer's. */
  @Input() banks: any[] = [];

  /**
   * Show the account's name instead of a dropdown. Transformed so a saved row
   * can write the bare `readonly` attribute, which is how it reads in a table.
   */
  @Input({ transform: booleanAttribute }) readonly = false;

  get visible(): boolean {
    return isBankLabelled(this.row);
  }

  get displayName(): string {
    return bankNameOf(this.banks, this.row?.bank_id) || '—';
  }

  /**
   * The dropdown's text: bank name plus the account's title, so several
   * accounts at one bank are told apart. Only the option list uses it —
   * `displayName` above is the saved row, which reads by `bank_name` like
   * every table cell and statement line in the app.
   */
  optionLabel(bank: any): string {
    return bankOptionLabel(bank);
  }
}
