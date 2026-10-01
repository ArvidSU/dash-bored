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
    const close = (event: KeyboardEvent): void => {
      const inTerminal = event.target instanceof HTMLElement && event.target.closest(".xterm") !== null;
      if (event.key === "Escape" && !event.defaultPrevented && !inTerminal) {
        event.preventDefault();
        dismissRef.current();
      }
    };
    window.addEventListener("keydown", close);
    const focusFrame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(
      "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)",
    )?.focus());
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", close);
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
