import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AccountLedgerComponent } from './account-ledger.component';

describe('AccountLedgerComponent', () => {
  let component: AccountLedgerComponent;
  let fixture: ComponentFixture<AccountLedgerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AccountLedgerComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AccountLedgerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
