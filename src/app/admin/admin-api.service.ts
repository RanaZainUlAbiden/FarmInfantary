import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom,timeout} from 'rxjs';
@Injectable({providedIn:'root'})
export class AdminApi {
 constructor(private http:HttpClient) {}
 async request(method:string,path:string,body?:unknown):Promise<any> {
  try {return await firstValueFrom(this.http.request<any>(method,path,{body}).pipe(timeout(20_000)));}
  catch(error:any){return {success:false,error:error?.error?.error||'Could not confirm the change. Check your connection and reload before trying again.'};}
 }
}
