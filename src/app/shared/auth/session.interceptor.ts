import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { catchError, mergeMap, of, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  if (!/^\/?api\//.test(request.url)) return next(request);
  const auth = inject(AuthService), epoch = auth.sessionEpoch;
  const guarded = /^\/?api\/(db\/|settings\/|account\/|admin\/)/.test(request.url), user = auth.getCurrentUser();
  if (guarded && !user) return throwError(() => new HttpErrorResponse({ status: 401, error: { success: false, error: 'Please sign in.' } }));
  request = request.clone({ withCredentials: true,
    ...(guarded && user ? { setHeaders: { 'X-FI-Session-Context': `${user.userId}:${user.farmId ?? 'platform'}` } } : {}) });
  return next(request).pipe(
    mergeMap(event => guarded && event instanceof HttpResponse && epoch !== auth.sessionEpoch
      ? throwError(() => new HttpErrorResponse({ status: 409, error: { error: 'Your sign-in changed. Please try again.' } })) : of(event)),
    catchError(error => {
      if (guarded && (error.status === 401 || error.status === 409 && error.error?.code === 'SESSION_CHANGED')) {
        auth.invalidate(error.status === 409 ? 'Your sign-in changed. Sign in again.' : 'Your session ended. Sign in again.', epoch);
      }
      // Authentication changes never replay a write.
      return throwError(() => error);
    }),
  );
};
