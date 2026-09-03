const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeMarkdownUrl(value: string): string {
  const url = value.trim();
  if (!url) return "";

  if (
    url.startsWith("#") ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("../")
  ) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}
