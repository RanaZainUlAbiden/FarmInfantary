import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ExpenseLedgerComponent } from './expense-ledger.component';

describe('ExpenseLedgerComponent', () => {
  let component: ExpenseLedgerComponent;
  let fixture: ComponentFixture<ExpenseLedgerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExpenseLedgerComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ExpenseLedgerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
