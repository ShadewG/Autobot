const MANUAL_REQUEST_MARKERS = ["/records-reports", "/recordsreports", "/records-report"];
const TRACKING_URL_PATTERNS = [
  /sendgrid\.net/i,
  /\.ct\.sendgrid\.net/i,
  /click\.mailchimp\.com/i,
  /track\.hubspot\.com/i,
  /links\.govdelivery\.com/i,
];

function normalizePortalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (TRACKING_URL_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function detectPortalProviderByUrl(url: string | null | undefined): string | null {
  const normalized = normalizePortalUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const path = (parsed.pathname || "/").toLowerCase();
    if (host.includes("govqa.us") || host.includes("custhelp.com") || host.includes("mycusthelp.com") || host.includes("mycusthelp.net")) {
      return "govqa";
    }
    if (host.includes("nextrequest.com")) {
      return "nextrequest";
    }
    if (host.includes("justfoia.com")) {
      return "justfoia";
    }
    if (host.includes("civicplus.com") && path.includes("/formcenter/")) {
      return "formcenter";
    }
    if (host.includes("civicplus.com")) {
      return "civicplus";
    }
    if (host === "app.smartsheet.com" && path.includes("/b/form/")) {
      return "smartsheet";
    }
    if (host.includes("coplogic.com")) {
      return "coplogic";
    }
  } catch (_) {}
  return null;
}

function isGenericJustFoiaRoot(url: string | null | undefined, provider: string | null | undefined): boolean {
  const normalized = normalizePortalUrl(url);
  if (!normalized) return false;
  const providerName = String(provider || detectPortalProviderByUrl(normalized) || "").toLowerCase();
  if (providerName !== "justfoia") return false;
  try {
    const parsed = new URL(normalized);
    const path = (parsed.pathname || "/").toLowerCase();
    return parsed.hostname.toLowerCase() === "request.justfoia.com" && (path === "/" || path === "");
  } catch (_) {
    return false;
  }
}

export function isNonAutomatablePortalProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  const value = String(provider).toLowerCase();
  return (
    value.includes("no online portal") ||
    value.includes("no online submission portal") ||
    value.includes("paper form required") ||
    value.includes("paper form") ||
    value.includes("mail-in form") ||
    value.includes("manual page") ||
    value.includes("pdf form download") ||
    value.includes("download only")
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
  const hasManualRequestMarker = MANUAL_REQUEST_MARKERS.some((needle) => value.includes(needle));
  const hasPortalMarker = portalLike.some((needle) => value.includes(needle));
  return hasManualRequestMarker || (hasContactMarker && !hasPortalMarker);
}

function isLikelyDocumentationPortalUrl(portalUrl: string | null | undefined): boolean {
  if (!portalUrl) return false;
  const value = String(portalUrl).toLowerCase();
  const documentationMarkers = [
    "/docs",
    "/documentation",
    "/help",
    "/support",
    "/faq",
    "/kb",
    "/knowledge",
  ];
  return documentationMarkers.some((needle) => value.includes(needle));
}

export function hasAutomatablePortal(
  portalUrl: string | null | undefined,
  provider: string | null | undefined,
  lastPortalStatus?: string | null
): boolean {
  const normalizedPortalUrl = normalizePortalUrl(portalUrl);
  if (!normalizedPortalUrl) return false;
  if (isNonAutomatablePortalProvider(provider)) return false;
  if (isNonAutomatablePortalStatus(lastPortalStatus)) return false;
  if (isGenericJustFoiaRoot(normalizedPortalUrl, provider)) return false;
  if (isLikelyContactInfoUrl(normalizedPortalUrl)) return false;
  if (isLikelyDocumentationPortalUrl(normalizedPortalUrl)) return false;
  return true;
}
