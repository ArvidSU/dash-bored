import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

/**
 * Shared chrome for the mutually exclusive right-side drawers (component
 * library flyout, agent work panel). Owns the slide transition, outside
 * dismiss, Escape, focus trap, and initial/restore focus so the two panels
 * cannot drift apart again. Content, draft/task state, and library-only
 * drag/removal modes stay with the callers.
 */
export const RIGHT_DRAWER_TRANSITION_MS = 220;

export interface RightDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  eyebrow?: string;
  /** Fixed row between the header and the scrollable body (e.g. library search). */
  filters?: ReactNode;
  children: ReactNode;
  /** Accessible label for the header close button. Defaults to `Close ${title}`. */
  closeLabel?: string;
  /** Focused on open; when omitted focus is left alone (trap still applies). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Selector for the trigger to restore focus to when the drawer had no prior owner. */
  restoreFocusSelector?: string;
  /** Library-only fold-away while a component drag is over the dashboard. */
  folded?: boolean;
  bodyClassName?: string;
  style?: CSSProperties;
}

export function RightDrawer({
  open,
  onClose,
  title,
  description,
  eyebrow,
  filters,
  children,
  closeLabel,
  initialFocusRef,
  restoreFocusSelector,
  folded = false,
  bodyClassName,
  style,
}: RightDrawerProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let openFrame: number | undefined;
    let closeTimer: number | undefined;
    if (open) {
      setRendered(true);
      openFrame = requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      closeTimer = window.setTimeout(() => setRendered(false), RIGHT_DRAWER_TRANSITION_MS);
    }
    return () => {
      if (openFrame !== undefined) cancelAnimationFrame(openFrame);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    };
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const target = initialFocusRef?.current;
    let focusFrame: number | undefined;
    if (target) focusFrame = requestAnimationFrame(() => target.focus());
    return () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      requestAnimationFrame(() => {
        if (restoreTarget?.isConnected) restoreTarget.focus();
        else if (restoreFocusSelector) {
          document.querySelector<HTMLElement>(restoreFocusSelector)?.focus();
        }
      });
    };
  }, [initialFocusRef, open, restoreFocusSelector]);

  useEffect(() => {
    if (!open) return;
    // The centered modal layer (`.editor-modal`, z-100) sits above the drawer
    // and owns its own Escape/backdrop dismiss. Events from inside it must not
    // dismiss the drawer or pull focus back out of it — the agent detail modal
    // is a child flow of the Agent work list.
    const insideModal = (event: Event): boolean =>
      (event.target as HTMLElement | null)?.closest?.(".editor-modal") != null;
    const handlePointerDown = (event: globalThis.PointerEvent): void => {
      if (insideModal(event)) return;
      if (event.button !== 0 || drawerRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (insideModal(event)) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])",
      ) ?? []).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey ? active === first : active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!drawerRef.current?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!rendered) return null;

  const className = [
    "right-drawer",
    open && visible ? "right-drawer--open" : "",
    folded ? "right-drawer--folded" : "",
  ].filter(Boolean).join(" ");

  return (
    <aside
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-hidden={!open}
      aria-modal="false"
      className={className}
      ref={drawerRef}
      role="dialog"
      style={filters ? style : { gridTemplateRows: "auto minmax(0, 1fr)", ...style }}
    >
      <header className="right-drawer__header">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button className="button button--quiet" type="button" aria-label={closeLabel ?? `Close ${title}`} onClick={onClose}>
          Close
        </button>
      </header>
      {filters ? <div className="right-drawer__filters">{filters}</div> : null}
      <div className={bodyClassName ? `right-drawer__body ${bodyClassName}` : "right-drawer__body"}>
        {children}
      </div>
    </aside>
  );
}
