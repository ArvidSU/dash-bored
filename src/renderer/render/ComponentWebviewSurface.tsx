import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { WebviewTagElement } from "electrobun/view";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";

/** Native mounting, visibility and security only. The component supplies its layout. */
export function ComponentWebviewSurface({ url, style, reloadKey, onNativeSurfaceSync }: {
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
