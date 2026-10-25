import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../shared/services/auth.service';
import { DatabaseService } from '../../shared/services/database.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { friendlySqlError } from '../../shared/utils/sql-error.util';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, ConfirmDialogComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnInit {
  farmName: string = '';
  password: string = '';
  errorMessage: string = '';
  isLoading: boolean = false;
  
  showSetup: boolean = false;
  showRegister: boolean = false;
  
  newFarmName: string = '';
  newPassword: string = '';
  confirmPassword: string = '';
  setupError: string = '';
  businessType: string = 'all';
  
  farms: any[] = [];
  farmsExist: boolean = false;

  showValidationDialog: boolean = false;
  validationMessage: string = '';

  constructor(
    private authService: AuthService,
    private db: DatabaseService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    await this.loadFarms();
    await this.checkFirstTime();
  }

  async loadFarms() {
    const result = await this.db.get(
      `SELECT farm_id, farm_name FROM farms ORDER BY created_at DESC`,
      []
    );
    if (result.success) {
      this.farms = result.data;
      this.farmsExist = this.farms.length > 0;
    }
  }

  async checkFirstTime() {
    if (this.farms.length === 0) {
      this.showSetup = true;
      this.showRegister = false;
    }
  }

  async onLogin() {
    if (!this.farmName || !this.password) {
      this.errorMessage = 'Please enter Username and Password';
      return;
    }
    this.isLoading = true;
    this.errorMessage = '';
    this.cdr.detectChanges();

    const success = await this.authService.login(this.farmName, this.password);

    if (success) {
      this.router.navigate(['/app']);
    } else {
      this.errorMessage = 'Invalid Username or Password';
    }
    this.isLoading = false;
    this.cdr.detectChanges();
  }

  openRegister() {
    this.showSetup = false;
    this.showRegister = true;
    this.newFarmName = '';
    this.newPassword = '';
    this.confirmPassword = '';
    this.setupError = '';
  }

  cancelRegister() {
    this.showRegister = false;
    this.showSetup = false;
    this.farmName = '';
    this.password = '';
    this.errorMessage = '';
  }

  cancelSetup() {
    this.showSetup = false;
    this.showRegister = false;
    this.farmName = '';
    this.password = '';
    this.errorMessage = '';
  }

  async onSetup() {
    await this.doRegistration();
    if (!this.setupError) {
      this.showSetup = false;
    }
  }

  async onRegister() {
    await this.doRegistration();
    if (!this.setupError) {
      this.showRegister = false;
      this.farmName = this.newFarmName;
      this.password = this.newPassword;
    }
  }

  async doRegistration() {
    if (!this.newFarmName || !this.newPassword) {
      this.setupError = 'Please fill all fields';
      return;
    }
    if (this.newPassword.length < 4) {
      this.setupError = 'Password must be at least 4 characters';
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.setupError = 'Passwords do not match';
      return;
    }

    const existing = await this.db.get(
      `SELECT farm_id FROM farms WHERE farm_name = ?`,
      [this.newFarmName]
    );
    if (existing.success && existing.data.length > 0) {
      this.setupError = 'Username already exists. Please choose another one.';
      return;
    }

    this.isLoading = true;
    this.setupError = '';
    this.cdr.detectChanges();

    const result = await this.authService.registerFarm(
      this.newFarmName,
      this.newPassword,
      this.businessType
    );

    if (result.success) {
      await this.loadFarms();
      this.newFarmName = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.setupError = '';
      
      if (this.farms.length === 1) {
        setTimeout(async () => {
          this.farmName = this.farms[0].farm_name;
          this.password = this.newPassword;
        }, 100);
      }
    } else {
      this.setupError = friendlySqlError(result.error, 'Registration failed. Please try again.');
    }
    
    this.isLoading = false;
    this.cdr.detectChanges();
  }

  quickFillFarm(name: string) {
    this.farmName = name;
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    if (passwordInput) {
      passwordInput.focus();
    }
  }

  showAllFarms() {
    this.validationMessage = 'All Registered Farms:\n' + this.farms.map(f => f.farm_name).join('\n');
    this.showValidationDialog = true;
  }
}