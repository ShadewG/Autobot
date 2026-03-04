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

export function isNonAutomatablePortalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const value = String(status).toLowerCase();
  return (
    value.includes("alternative path required") ||
    value.includes("pdf_form_pending") ||
    value.includes("not_real_portal") ||
    value.includes("contact_info_only") ||
    value.includes("manual_research_required")
  );
}

function isLikelyContactInfoUrl(portalUrl: string | null | undefined): boolean {
  if (!portalUrl) return false;
  const value = String(portalUrl).toLowerCase();
  const contactLike = [
    "/contact",
    "/contacts",
    "/staff",
    "/directory",
    "/about",
    "/pio",
  ];
  const portalLike = [
    "/portal",
    "/request",
    "/requests",
    "nextrequest",
    "publicrecords",
    "recordrequest",
    "foia",
  ];

  const hasContactMarker = contactLike.some((needle) => value.includes(needle));
  const hasPortalMarker = portalLike.some((needle) => value.includes(needle));
  return hasContactMarker && !hasPortalMarker;
}

export function hasAutomatablePortal(
  portalUrl: string | null | undefined,
  provider: string | null | undefined,
  lastPortalStatus?: string | null
): boolean {
  if (!portalUrl) return false;
  if (isNonAutomatablePortalProvider(provider)) return false;
  if (isNonAutomatablePortalStatus(lastPortalStatus)) return false;
  if (isLikelyContactInfoUrl(portalUrl)) return false;
  return true;
}
