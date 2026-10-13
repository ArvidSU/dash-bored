const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

interface EventSource {
  on(name: string, handler: (event: unknown) => void): unknown;
}

/**
 * Returns the URL a `new-window-open` event asks for when the system browser
 * may open it. Other schemes (file:, javascript:, views:, custom handlers) stay
 * inside the app and are dropped.
 */
export function externalLinkUrl(event: unknown): string | null {
  const detail = (event as { data?: { detail?: unknown } } | null)?.data?.detail;
  const raw = typeof detail === "string" ? detail : (detail as { url?: unknown } | null)?.url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * WebKit drops `target="_blank"` links and `window.open` calls because the app
 * never creates secondary windows. Hand those requests for the given webview to
 * the user's default browser instead.
 */
export function openNewWindowsExternally(
  events: EventSource,
  webviewId: number,
  openExternal: (url: string) => boolean,
): void {
  events.on(`new-window-open-${webviewId}`, (event) => {
    const url = externalLinkUrl(event);
    if (url && !openExternal(url)) console.error("Could not open link in the default browser:", url);
  });
}
