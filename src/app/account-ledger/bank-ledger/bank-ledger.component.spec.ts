import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BankLedgerComponent } from './bank-ledger.component';

describe('BankLedgerComponent', () => {
  let component: BankLedgerComponent;
  let fixture: ComponentFixture<BankLedgerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BankLedgerComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(BankLedgerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
