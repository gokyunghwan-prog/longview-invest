const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function buildSecRequestHeaders(declaredIdentity) {
  const declared = String(declaredIdentity || "").trim();
  const email = declared.match(EMAIL_PATTERN)?.[0] || null;
  const productName = declared
    .replace(EMAIL_PATTERN, "")
    .trim()
    .replace(/[^A-Za-z0-9._~/-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "LongviewInvest";
  const userAgent = productName.includes("/") ? productName : productName + "/1.0";

  return {
    "User-Agent": userAgent.slice(0, 128),
    ...(email ? { From: email } : {})
  };
}
