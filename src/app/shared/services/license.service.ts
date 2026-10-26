import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
/** Compatibility facade: server account status replaces machine licensing. */
@Injectable({providedIn:'root'})
export class LicenseService {
 constructor(private http:HttpClient){}
 async validateActivationKey(_key:string):Promise<boolean>{return false;}
 async startTrial():Promise<void>{}
 async activate(_key:string):Promise<void>{}
 async isActivated():Promise<boolean>{return (await this.getStatus()).activated;}
 async getLicenseDaysRemaining():Promise<number>{return 0;}
 async getStatus(){let active=false;try{const r=await firstValueFrom(this.http.get<{success:boolean;active:boolean}>('/api/account/entitlement').pipe(timeout(10_000)));active=r.success===true&&r.active===true;}catch{}
  return {activated:active,isPermanent:false,trialExpired:!active,daysRemaining:0,expiryDate:null as string|null,trialStarted:false,clockTampered:false,licenseDaysRemaining:0,activationCycle:0};}
 async updateLastLaunchDate():Promise<void>{}
 async getTrialStatusMessage():Promise<string>{return 'Account access could not be checked';}
}
