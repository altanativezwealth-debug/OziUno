/** True when a provider app is embedded via Product Run / tenant agent handoff. */
export function isTenantDelegationCanvas(): boolean {
  if (typeof window === "undefined") return false;
  const layout = new URLSearchParams(window.location.search).get("layout");
  if (layout === "full") return false;
  return (
    !!(window as Window & { __TENANT_DELEGATION__?: unknown }).__TENANT_DELEGATION__ ||
    !!(window as Window & { __TENANT_DELEGATION_CANVAS__?: unknown })
      .__TENANT_DELEGATION_CANVAS__ ||
    layout === "canvas-only"
  );
}
