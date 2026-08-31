import { useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WebviewTagElement } from "electrobun/view";
import { ComponentVisibilityContext } from "./ComponentCompositor";

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
  const [mounted, setMounted] = useState(visible);
  const validUrl = useMemo(() => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, [url]);

  useLayoutEffect(() => {
    if (visible && validUrl) setMounted(true);
  }, [validUrl, visible]);

  useLayoutEffect(() => {
    const view = ref.current;
    if (!view) return;
    view.toggleHidden(!visible);
    if (visible) view.syncDimensions(true);
    onNativeSurfaceSync?.({ visible, mounted });
  }, [mounted, onNativeSurfaceSync, visible]);

  if (!validUrl) {
    return (
      <div className="component-state component-state--error" role="alert">
        Native webviews require an absolute HTTP or HTTPS URL.
      </div>
    );
  }

  return (
    <section className="webview-shell">
      <header className="webview-shell__header">
        <span className="webview-shell__url" title={url}>{title?.trim() || url}</span>
        <button className="button button--quiet" type="button" onClick={() => ref.current?.reload()}>
          Reload
        </button>
      </header>
      {mounted ? (
        <electrobun-webview ref={ref} className="webview-shell__view" renderer="native" sandbox src={url} />
      ) : null}
    </section>
  );
}
