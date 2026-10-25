import { InjectionToken } from '@angular/core';
import { PlatformApi } from './platform-api';

/**
 * The one place the app learns where its data comes from.
 *
 * Injected rather than imported so a test can supply a fake without touching
 * `DatabaseService`, and so the transport can change again without any screen
 * knowing about it.
 */
export const PLATFORM_API = new InjectionToken<PlatformApi>('PLATFORM_API');
