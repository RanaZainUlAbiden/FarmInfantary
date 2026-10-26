import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
@Component({ selector: 'app-password-field', standalone: true,
  templateUrl: './password-field.component.html', styleUrl: './password-field.component.scss' })
export class PasswordFieldComponent {
  @Input() inputId = 'password'; @Input() label = 'Password'; @Input() value = '';
  @Input() disabled = false; @Input() invalid = false; @Input() describedBy = '';
  @Input() autocomplete: 'current-password' | 'new-password' = 'current-password';
  @Output() valueChange = new EventEmitter<string>();
  @ViewChild('passwordInput') input?: ElementRef<HTMLInputElement>;
  visible = false;
  constructor(private cdr: ChangeDetectorRef) {}
  toggleVisibility() { this.visible = !this.visible; this.cdr.detectChanges(); }
  onInput(event: Event) { this.valueChange.emit((event.target as HTMLInputElement).value); }
  focus() { this.input?.nativeElement.focus(); }
}
