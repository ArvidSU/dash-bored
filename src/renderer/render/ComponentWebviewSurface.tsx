import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WebviewTagElement } from "electrobun/view";
import { ComponentVisibilityContext } from "../composition/ComponentCompositor";

export function ComponentWebviewSurface({
  url,
  title,
  onNativeSurfaceSync,
}: {
  url: string;
  title?: string;
  /** Used by the isolated native probe; ordinary component rendering ignores it. */
  onNativeSurfaceSync?: (state: { visible: boolean; mounted: boolean }) => void;
}): ReactNode {
  const visible = useContext(ComponentVisibilityContext);
  const ref = useRef<WebviewTagElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const validUrl = useMemo(() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

  useLayoutEffect(() => {
    if (!visible || !validUrl || mounted) return;
    let frame = 0;
    const mountWhenSized = (): void => {
      frame = 0;
      const rect = placeholderRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const shellWidth = shellRef.current?.clientWidth ?? 0;
      if (shellWidth <= 0) return;
      setMounted(true);
    };
    const scheduleMount = (): void => {
      if (!frame) frame = requestAnimationFrame(mountWhenSized);
    };
    const shell = shellRef.current;
    const placeholder = placeholderRef.current;
    if (!shell || !placeholder) return;
    const observer = new ResizeObserver(scheduleMount);
    observer.observe(shell);
    observer.observe(placeholder);
    scheduleMount();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mounted, validUrl, visible]);

  useLayoutEffect(() => {
    const view = ref.current;
    if (!view) return;
    if (typeof view.toggleHidden === "function") view.toggleHidden(!visible);
    if (!visible) {
      onNativeSurfaceSync?.({ visible, mounted });
      return;
    }
    const shell = shellRef.current;
    if (!shell) {
      onNativeSurfaceSync?.({ visible, mounted });
      return;
    }
    let frame = 0;
    const applySize = (): void => {
      const width = shell.getBoundingClientRect().width;
      if (width <= 0) return;
      const height = Math.max(320, Math.min(720, width * 9 / 16));
      // Electrobun injects a default 800×300 style for every native tag. Set
      // the measured frame imperatively before its next animation-frame init so
      // the native child cannot retain that default rectangle.
      view.style.setProperty("width", `${width}px`, "important");
      view.style.setProperty("height", `${height}px`, "important");
    };
    const sync = (): void => {
      frame = 0;
      applySize();
      view.syncDimensions?.(true);
    };
    const scheduleSync = (): void => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(shell);
    observer.observe(view);
    window.addEventListener("scroll", scheduleSync, true);
    scheduleSync();
    onNativeSurfaceSync?.({ visible, mounted });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", scheduleSync, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mounted, onNativeSurfaceSync, visible]);

  if (!validUrl) {
    return (
      <div className="component-state component-state--error" role="alert">
        Native webviews require an absolute HTTP or HTTPS URL.
      </div>
    );
  }

  return (
    <section className="webview-shell" ref={shellRef}>
      <header className="webview-shell__header">
        <span className="webview-shell__url" title={url}>{title?.trim() || url}</span>
        <button className="button button--quiet" type="button" onClick={() => ref.current?.reload()}>
          Reload
        </button>
      </header>
      {mounted ? (
        <electrobun-webview
          ref={ref}
          className="webview-shell__view"
          renderer="native"
          sandbox
          src={url}
        />
      ) : <div className="webview-shell__placeholder" ref={placeholderRef} aria-hidden="true" />}
    </section>
  );
}
