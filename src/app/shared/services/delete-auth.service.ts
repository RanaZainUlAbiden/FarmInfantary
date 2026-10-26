import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
@Injectable({providedIn:'root'})
export class DeleteAuthService {
 message='';constructor(private http:HttpClient){}
 async verifyCode(code:string):Promise<boolean>{
  try{const r=await firstValueFrom(this.http.post<{success:boolean}>('/api/account/delete-code/verify',{code}).pipe(timeout(15_000)));this.message='';return r.success===true;}
  catch(error:any){this.message=error?.error?.error||'Could not verify the delete code. Check your connection and try again.';return false;}
 }
}
