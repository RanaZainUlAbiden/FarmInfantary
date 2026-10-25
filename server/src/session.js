/**
 * TEMPORARY development session. Phase 3 replaces this entirely.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  READ THIS BEFORE USING IT ANYWHERE THAT MATTERS
 * ────────────────────────────────────────────────────────────────────────
 *
 * The real design (D7, D8) resolves `farm_id`, `user_id` and `role` from an
 * httpOnly session cookie on every request, and NEVER from anything the client
 * sends. Until that exists, the endpoints still need a farm to scope to.
 *
 * The obvious shortcut — read `farm_id` from the request body or a header —
 * is the exact vulnerability this whole architecture exists to prevent, and a
 * "temporary" one has a way of surviving. So this does not do that.
 *
 * Instead: one fixed development farm, from DEV_FARM_ID, and the server
 * REFUSES TO START in production with this module active. The failure is loud
 * and at boot, not quiet and in a request handler.
 */

const DEV_ONLY = 'development';

export function createDevSession(env = process.env) {
  if (env.NODE_ENV && env.NODE_ENV !== DEV_ONLY) {
    throw new Error(
      `Refusing to start: the development session stub is active but NODE_ENV is ` +
      `"${env.NODE_ENV}". Real sessions arrive in Phase 3 (docs/DECISIONS.md D7). ` +
      `This stub scopes every request to one fixed farm and authenticates nobody.`
    );
  }

  const farmId = Number(env.DEV_FARM_ID ?? 1);
  if (!Number.isSafeInteger(farmId) || farmId < 1) {
    throw new Error(`DEV_FARM_ID must be a positive integer, got "${env.DEV_FARM_ID}".`);
  }

  return {
    stub: true,
    /**
     * What a request is allowed to act as. Deliberately ignores the request:
     * nothing a client sends can change which farm it reaches.
     */
    resolve() {
      return { farmId, userId: null, role: 'farm_admin' };
    },
  };
}
