import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { WebviewTagElement } from "electrobun/view";
import { ComponentLayoutVisibilityContext, ComponentVisibilityContext } from "../composition/ComponentCompositor";

/** Host-owned embedding; components keep control of layout and presentation. */
export function ComponentWebviewSurface({ renderer = "iframe", ...request }: {
  url: string;
  style?: CSSProperties;
  reloadKey?: string | number;
  renderer?: "iframe" | "native";
  onNativeSurfaceSync?: (state: { visible: boolean; mounted: boolean }) => void;
}): ReactNode {
  // Accepted temporary risk: Electrobun 2.0.4 exposes privileged preload and
  // bridge handlers to subframes. Track the runtime upgrade and native proof
  // in dashboard todo iframe-runtime-isolation and architecture/security.md.
  return renderer === "native" ? <NativeWebviewSurface {...request} /> : <IframeSurface {...request} />;
}

function IframeSurface({ url, style, reloadKey }: {
  url: string;
  style?: CSSProperties;
  reloadKey?: string | number;
}): ReactNode {
  const visible = useContext(ComponentLayoutVisibilityContext);
  const [mounted, setMounted] = useState(visible);
  useLayoutEffect(() => { if (visible) setMounted(true); }, [visible]);
  let valid = false;
  let sameOrigin = false;
  try {
    const parsed = new URL(url);
    valid = ["http:", "https:"].includes(parsed.protocol);
    sameOrigin = parsed.origin === window.location.origin;
  } catch { /* Invalid URL. */ }
  if (!valid) return <div role="alert">Embedded pages require an absolute HTTP or HTTPS URL.</div>;
  if (sameOrigin) return <div role="alert">The dashboard's own origin cannot be embedded. Use a separate preview server.</div>;
  // Preserve the embedded app's storage and module loading. The renderer uses
  // views: in production (excluded by frame-src); development responses carry
  // frame-ancestors 'none' to prevent redirects back into the privileged origin.
  return <div style={{ ...style, display: visible ? undefined : "none" }}>
    {mounted && <iframe key={reloadKey} src={url} title="Embedded application"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerPolicy="no-referrer"
      style={{ width: "100%", height: "100%", border: 0, display: "block" }} />}
  </div>;
}

/** Native mounting, visibility and security only. The component supplies its layout. */
function NativeWebviewSurface({ url, style, reloadKey, onNativeSurfaceSync }: {
  url: string;
  style?: CSSProperties;
  reloadKey?: string | number;
  /** Used by the isolated native probe. */
  onNativeSurfaceSync?: (state: { visible: boolean; mounted: boolean }) => void;
}): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const ref = useRef<WebviewTagElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const previousReload = useRef(reloadKey);
  const validUrl = useMemo(() => {
    try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
  }, [url]);
  useLayoutEffect(() => {
    if (previousReload.current !== reloadKey) ref.current?.reload();
    previousReload.current = reloadKey;
  }, [reloadKey]);
  useLayoutEffect(() => {
    if (!visible || !validUrl || mounted) return;
    let frame = 0;
    const mountWhenSized = (): void => {
      frame = 0;
      const rect = placeholderRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) setMounted(true);
    };
    const scheduleMount = (): void => { if (!frame) frame = requestAnimationFrame(mountWhenSized); };
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(scheduleMount);
    observer.observe(shell);
    scheduleMount();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [mounted, validUrl, visible]);
  useLayoutEffect(() => {
    const view = ref.current;
    if (!view) return;
    if (typeof view.toggleHidden === "function") view.toggleHidden(!visible);
    if (!visible) { onNativeSurfaceSync?.({ visible, mounted }); return; }
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    const sync = (): void => {
      frame = 0;
      const { width, height } = shell.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      // Override Electrobun's injected dimensions with the caller's measured box.
      view.style.setProperty("width", `${width}px`, "important");
      view.style.setProperty("height", `${height}px`, "important");
      view.syncDimensions?.(true);
    };
    const scheduleSync = (): void => { if (!frame) frame = requestAnimationFrame(sync); };
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(shell);
    window.addEventListener("scroll", scheduleSync, true);
    scheduleSync();
    onNativeSurfaceSync?.({ visible, mounted });
    return () => { observer.disconnect(); window.removeEventListener("scroll", scheduleSync, true); if (frame) cancelAnimationFrame(frame); };
  }, [mounted, onNativeSurfaceSync, validUrl, visible]);
  if (!validUrl) return <div role="alert">Native webviews require an absolute HTTP or HTTPS URL.</div>;
  return <div ref={shellRef} style={style}>
    {mounted ? <electrobun-webview ref={ref} renderer="native" sandbox src={url} />
      : <div ref={placeholderRef} style={{ width: "100%", height: "100%" }} aria-hidden="true" />}
  </div>;
}
