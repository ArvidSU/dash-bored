import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  className?: string;
  onDismiss: () => void;
}

export function EditorModal({ title, children, className, onDismiss }: ModalProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const titleId = useId();
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      // A discard confirmation can sit above another editor. Only the front
      // dialog owns keyboard dismissal and its Tab boundary.
      const modals = document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']");
      if (!panel || modals.item(modals.length - 1) !== panel || event.defaultPrevented) return;
      const inInteractiveSurface = event.target instanceof HTMLElement && event.target.closest("[data-dashboard-interactive]") !== null;
      if (event.key === "Escape" && !inInteractiveSurface) {
        event.preventDefault();
        dismissRef.current();
      } else if (event.key === "Tab") {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(
          "a[href], button, input, textarea, select, summary, [tabindex], [contenteditable='true']",
        )).filter((control) => control.tabIndex >= 0
          && !control.matches(":disabled")
          && !control.closest("[hidden], [inert], [aria-hidden='true']")
          && control.getClientRects().length > 0
          && getComputedStyle(control).visibility === "visible");
        const tabStops = controls.filter((control) => {
          if (!(control instanceof HTMLInputElement) || control.type !== "radio" || !control.name) return true;
          const group = controls.filter((candidate): candidate is HTMLInputElement => candidate instanceof HTMLInputElement
            && candidate.type === "radio" && candidate.name === control.name && candidate.form === control.form);
          return control === (group.find((radio) => radio.checked) ?? group[0]);
        }).sort((first, second) => (first.tabIndex || Infinity) - (second.tabIndex || Infinity));
        const active = document.activeElement;
        const current = tabStops.findIndex((control) => control === active);
        const ordered = event.shiftKey ? [...tabStops].reverse() : tabStops;
        // Choose every Tab destination ourselves: macOS WebKit can skip
        // ordinary buttons, including a modal's computed final boundary.
        // A permission heading (tabIndex=-1) resumes at the next DOM control.
        const target = current >= 0
          ? tabStops[(current + (event.shiftKey ? -1 : 1) + tabStops.length) % tabStops.length]
          : ordered.find((control) => active && panel.contains(active)
            && (active.compareDocumentPosition(control) & (event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING))) ?? ordered[0];
        event.preventDefault();
        target?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    // A panel may name its primary field; otherwise the first enabled control wins.
    const focusFrame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      // A user or child may focus a field before this deferred callback runs.
      if (!panel || panel.contains(document.activeElement)) return;
      (panel.querySelector<HTMLElement>("[data-modal-autofocus]:not(:disabled)")
      ?? panel.querySelector<HTMLElement>(
        "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)",
      )
      )?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".composition-library-trigger")?.focus();
    };
  }, []);
  return (
    <div className="editor-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onDismiss();
    }}>
      <div className={className ? `editor-modal__panel ${className}` : "editor-modal__panel"} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="editor-modal__header">
          <h2 id={titleId}>{title}</h2>
          <button className="editor-icon-button" type="button" aria-label="Close" onClick={onDismiss}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}
