import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FlockHealthComponent } from './flock-health.component';

describe('FlockHealthComponent', () => {
  let component: FlockHealthComponent;
  let fixture: ComponentFixture<FlockHealthComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FlockHealthComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FlockHealthComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
