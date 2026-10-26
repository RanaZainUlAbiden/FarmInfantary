// Optional browser stale-account precondition; never an identity source. Raw
// clients cannot gain a different farm by changing or omitting this header.
export function sameSessionContext(request, actor) {
  const supplied = request.headers['x-fi-session-context'];
  return supplied === undefined || supplied === `${actor.userId}:${actor.farmId ?? 'platform'}`;
}
