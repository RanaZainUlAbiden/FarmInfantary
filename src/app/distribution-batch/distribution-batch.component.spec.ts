import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DistributionBatchComponent } from './distribution-batch.component';

describe('DistributionBatchComponent', () => {
  let component: DistributionBatchComponent;
  let fixture: ComponentFixture<DistributionBatchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DistributionBatchComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DistributionBatchComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
