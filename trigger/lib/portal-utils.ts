export function isNonAutomatablePortalProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const value = String(provider).toLowerCase();
  return (
    value.includes("no online portal") ||
    value.includes("paper form required") ||
    value.includes("paper form") ||
    value.includes("mail-in form")
  );
}

export function hasAutomatablePortal(
  portalUrl: string | null | undefined,
  provider: string | null | undefined
): boolean {
  if (!portalUrl) return false;
  if (isNonAutomatablePortalProvider(provider)) return false;
  return true;
}

