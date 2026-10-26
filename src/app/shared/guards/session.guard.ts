import { inject } from '@angular/core';
import { CanActivateFn, CanActivateChildFn, Router } from '@angular/router';
import { AuthService, safeReturnUrl } from '../services/auth.service';
export const sessionGuard: CanActivateFn & CanActivateChildFn = async (_route, state) => {
  const auth = inject(AuthService), router = inject(Router); await auth.initialize();
  if (!auth.isLoggedIn()) return router.createUrlTree(['/login'], { queryParams: { returnUrl: safeReturnUrl(state.url) } });
  return auth.canUseBusinessApp() || router.createUrlTree(['/access']);
};
export const signedInGuard: CanActivateFn = async () => {
  const auth = inject(AuthService), router = inject(Router); await auth.initialize();
  return auth.isLoggedIn() || router.createUrlTree(['/login']);
};
export const adminGuard:CanActivateFn=async()=>{
 const auth=inject(AuthService),router=inject(Router);await auth.initialize();
 return auth.getCurrentUser()?.role==='super_admin'||router.createUrlTree([auth.isLoggedIn()?'/access':'/login']);
};
export const teamGuard:CanActivateFn=async()=>{
 const auth=inject(AuthService),router=inject(Router);await auth.initialize();
 return auth.getCurrentUser()?.role==='farm_admin'||router.createUrlTree([auth.isLoggedIn()?'/access':'/login'],{queryParams:{returnUrl:'/team'}});
};
