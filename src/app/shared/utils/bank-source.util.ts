/**
 * Cash or bank, on every screen where money is received or paid.
 *
 * Nine tables can now be the source of a real bank movement. `BANK_SOURCES` in
 * `database.service.ts` owns the write side — the ledger entry, the reversal,
 * the balance rebuild. This file owns the small amount of shared thinking that
 * happens before that, on the form:
 *
 *   - which field on the row says "bank"
 *   - whether the row is complete enough to save
 *   - what `payment_source` / `bank_id` to write
 *
 * WHY TWO DIFFERENT FIELDS. Six of the nine tables already carried a
 * `payment_type`, and four already offered the user a "Bank" option in it —
 * free text, no account, no ledger effect, filtered on by no report anywhere.
 * On those screens `payment_type` IS the Cash/Bank selector and a second one
 * beside it would let a row claim both; `payment_source` is derived from it at
 * save time.
 *
 * `purchase_orders` is the exception. Its payment_type is "Paid (Debit)" vs
 * "Unpaid (Credit)" — a settlement status that drives `supplier_ledger`, not a
 * source. Adding 'bank' to it would flip `isPaid` and move the supplier
 * payable, so there the Cash/Bank selector is its own `payment_source` field,
 * shown only on a paid order. `income` is a third shape again: it had no
 * selector at all, so it gets `payment_source` directly.
 */

/** A form row carrying whichever of the two fields its screen uses. */
export interface BankSourceRow {
  payment_type?: string | null;
  payment_source?: string | null;
  bank_id?: number | null;
}

/**
 * Is this row bank-sourced, whichever field its screen drives?
 *
 * Note the asymmetry with `isBankLabelled()` below: a row is bank-SOURCED only
 * once an account is attached, because that is what the ledger entry is keyed
 * to. The dropdown is revealed by the label; the entry is written by the
 * source.
 */
export function isBankSourced(row: BankSourceRow | null | undefined): boolean {
  return !!row && isBankLabelled(row) && !!Number(row.bank_id);
}

/** Has the user chosen "Bank", whether or not they have picked an account yet? */
export function isBankLabelled(row: BankSourceRow | null | undefined): boolean {
  if (!row) return false;
  if (row.payment_source !== undefined && row.payment_source !== null) {
    return row.payment_source === 'bank';
  }
  return row.payment_type === 'bank';
}

/** The pair to write: 'bank' with an account, or 'cash' with none. */
export function bankSourceFields(row: BankSourceRow | null | undefined):
  { payment_source: string; bank_id: number | null } {
  const bankId = Number(row?.bank_id) || null;
  return isBankLabelled(row) && bankId
    ? { payment_source: 'bank', bank_id: bankId }
    : { payment_source: 'cash', bank_id: null };
}

/**
 * The reason this row cannot be saved yet, or null.
 *
 * A row labelled Bank with no account chosen is refused rather than quietly
 * saved as cash. That is the whole point of the change: a bank payment that
 * never reaches a bank account is the defect this mechanism exists to prevent,
 * and silently downgrading it would reintroduce that through the form.
 *
 * It is also what a LEGACY row hits. Rows saved before any of this existed
 * carry payment_type = 'bank' with no account and no entry, which is honest —
 * nothing was ever posted for them. Editing one requires attributing it, and
 * from then on it carries a real entry. The alternative, letting the edit pass
 * as cash, means the user corrects a bank expense and it still never reaches
 * the bank.
 */
export function bankSourceError(
  row: BankSourceRow | null | undefined,
  banks: any[],
  rowLabel = ''
): string | null {
  if (!isBankLabelled(row)) return null;
  const where = rowLabel ? `${rowLabel}: ` : '';

  if (!banks || banks.length === 0) {
    return `${where}there are no bank accounts set up yet. ` +
           'Add one under Overview > Bank, or record this as cash.';
  }
  if (!Number(row?.bank_id)) {
    return `${where}choose which bank account the money went through.`;
  }
  if (!banks.some(b => Number(b.bank_id) === Number(row?.bank_id))) {
    return `${where}that bank account no longer exists — choose another.`;
  }
  return null;
}

/**
 * How a labour payment's settlement reads on a report.
 *
 * Both labour PDFs used to render `payment_type === 'cash' ? 'Cash' : 'Credit'`,
 * which was fine while those were the only two values and became wrong the
 * moment the screen offered Bank — a bank-paid wage would have printed as
 * unpaid. Taken off the value instead, so a third option can never silently
 * mislabel a fourth.
 */
export function labourPaymentLabel(payment: { payment_type?: string | null }): string {
  const type = (payment?.payment_type || 'cash').toLowerCase();
  if (type === 'cash') return 'Cash';
  if (type === 'bank') return 'Bank';
  if (type === 'credit') return 'Credit';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * How a row's payment source reads on a table or a printed document: 'Cash',
 * or 'Bank · <account>'.
 *
 * This existed twice, identically, on `assets.component.ts` and
 * `personal-expenses.component.ts`, and every new money screen wants it. Taken
 * off `payment_source` — the normalized fact that money moved through a named
 * account — rather than off `payment_type`, which is only the label the user
 * put on the row.
 *
 * `bank_name` is preferred when the caller's query LEFT JOINed it, since that
 * survives the account being renamed afterwards; `banks` is the fallback for a
 * screen that holds the account list instead.
 */
export function paymentSourceLabel(
  row: { payment_source?: string | null; bank_id?: number | null; bank_name?: string | null } | null | undefined,
  banks: any[] = []
): string {
  if (row?.payment_source === 'broker') return 'Broker direct';
  if (row?.payment_source !== 'bank') return 'Cash';
  return 'Bank · ' + (row.bank_name || bankNameOf(banks, row.bank_id) || 'account');
}

/** The account's name for a table cell or a statement line. */
export function bankNameOf(banks: any[], bankId: number | null | undefined): string {
  const id = Number(bankId) || 0;
  if (!id) return '';
  const bank = (banks || []).find(b => Number(b.bank_id) === id);
  return bank ? (bank.bank_name || `Account #${id}`) : `Account #${id}`;
}

/**
 * How one account reads in a PICKER: `"HBL Main — Mian Ahmed"`.
 *
 * The client's own accounts are several at the same bank, told apart only by
 * whose name the account is in — the "title" they ask for, stored as
 * `account_holder`. A dropdown of four options all reading "HBL" is a dropdown
 * the user cannot use, and picking the wrong one records the money against the
 * wrong account with nothing on screen to say so.
 *
 * Falls back to the account number when no title is on file, and to the bare
 * bank name when neither is — so an account entered with nothing but a name
 * still reads as itself rather than as a dangling dash.
 *
 * DISPLAY ONLY. Nothing is stored from this, and it is deliberately NOT what
 * `bankNameOf()` returns: that one names the account on a saved row, a table
 * cell and a printed statement, where the row's own columns already carry the
 * context and `bank_name` is what every one of those reads by.
 */
export function bankOptionLabel(
  bank: { bank_name?: string | null; account_holder?: string | null; account_number?: string | null } | null | undefined
): string {
  const name = (bank?.bank_name || '').trim();
  const qualifier = (bank?.account_holder || '').trim() || (bank?.account_number || '').trim();
  if (!name) return qualifier || '';
  return qualifier ? `${name} — ${qualifier}` : name;
}
