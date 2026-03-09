export function normalizeEmailAddress(value) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : null;
}

export function normalizeEmailDomain(value) {
  const email = normalizeEmailAddress(value);
  if (!email) return null;
  const parts = email.split("@");
  return parts.length === 2 ? parts[1] : null;
}

export function collectExpectedAgencyEmails(caseData, thread) {
  return Array.from(
    new Set(
      [thread?.agency_email, caseData?.agency_email, caseData?.alternate_agency_email]
        .map((value) => normalizeEmailAddress(value))
        .filter(Boolean)
    )
  );
}

export function shouldEscalateManualPasteMismatch(message, thread, caseData) {
  const metadata = (message?.metadata || {});
  const isManualPaste = metadata.manual_paste === true || metadata.source === "manual_paste";
  const senderEmail = normalizeEmailAddress(message?.from_email);
  const expectedEmails = collectExpectedAgencyEmails(caseData, thread);
  const senderDomain = normalizeEmailDomain(senderEmail);
  const expectedDomains = Array.from(
    new Set(expectedEmails.map((email) => normalizeEmailDomain(email)).filter(Boolean))
  );

  if (!isManualPaste || message?.direction !== "inbound" || !senderEmail || expectedEmails.length === 0) {
    return {
      mismatch: false,
      senderEmail,
      expectedEmails,
      senderDomain,
      expectedDomains,
    };
  }

  if (expectedEmails.includes(senderEmail)) {
    return {
      mismatch: false,
      senderEmail,
      expectedEmails,
      senderDomain,
      expectedDomains,
    };
  }

  if (!senderDomain || expectedDomains.length === 0) {
    return {
      mismatch: false,
      senderEmail,
      expectedEmails,
      senderDomain,
      expectedDomains,
    };
  }

  return {
    mismatch: !expectedDomains.includes(senderDomain),
    senderEmail,
    expectedEmails,
    senderDomain,
    expectedDomains,
  };
}
