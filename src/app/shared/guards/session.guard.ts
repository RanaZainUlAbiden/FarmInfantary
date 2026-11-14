import { inject } from '@angular/core';
import { CanActivateFn, CanActivateChildFn, Router } from '@angular/router';
import { AuthService, safeReturnUrl } from '../services/auth.service';
import { businessTabs } from '../utils/business-modules';
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
// Screens that belong to exactly one module. Shared screens (expenses, feed, medicine,
// income, farm-report, farm-units...) and every Distribution screen are not listed:
// each business bundle includes Distribution and at least one of Broiler/Layer.
// This is a UX boundary only; tenant data is still protected by the SQL guard (RLS).
const BROILER_ONLY = new Set(['flock-health', 'ledger', 'chicks', 'sale', 'balance', 'report', 'flock-management']);
const LAYER_ONLY = new Set(['batch-management', 'egg-collection', 'egg-sales', 'hen-sales', 'layer-expenses',
  'layer-flock-health', 'layer-ledger', 'layer-report']);
export const moduleGuard: CanActivateChildFn = async (childRoute) => {
  const auth = inject(AuthService), router = inject(Router); await auth.initialize();
  const tabs = businessTabs(auth.getCurrentFarm()?.business_type);
  const path = childRoute.routeConfig?.path?.split('/')[0] ?? '';
  const blocked = (BROILER_ONLY.has(path) && !tabs.includes('broiler')) || (LAYER_ONLY.has(path) && !tabs.includes('layer'));
  if (!blocked) return true;
  return router.createUrlTree(['/app', tabs.includes('broiler') ? 'flock-health' : 'batch-management']);
};
