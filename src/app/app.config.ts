import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { sessionInterceptor } from './shared/auth/session.interceptor';

import { routes } from './app.routes';
import { PLATFORM_API } from './shared/platform/platform.token';
import { HttpPlatformApi } from './shared/platform/http-platform-api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),

    // `withFetch` so requests go through the Fetch API rather than XHR, which
    // is what the session cookie work in Phase 3 will need.
    provideHttpClient(withFetch(), withInterceptors([sessionInterceptor])),

    // The single line that decides where the app's data comes from.
    { provide: PLATFORM_API, useExisting: HttpPlatformApi },
  ]
};
