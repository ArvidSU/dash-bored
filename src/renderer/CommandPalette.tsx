import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { PaletteAction } from "./actions";
import { rankActions } from "./actions";

interface CommandPaletteProps {
  open: boolean;
  actions: readonly PaletteAction[];
  runningActionIds: ReadonlySet<string>;
  onDismiss(): void;
  onExecute(id: string): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function optionId(index: number): string {
  return `command-palette-option-${index}`;
}

export function CommandPalette({
  open,
  actions,
  runningActionIds,
  onDismiss,
  onExecute,
}: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const effectiveActions = useMemo(
    () =>
      actions.map((action) =>
        runningActionIds.has(action.id)
          ? {
              ...action,
              enabled: false,
              disabledReason: "This action is already running.",
            }
          : action,
      ),
    [actions, runningActionIds],
  );
  const ranked = useMemo(
    () => rankActions(effectiveActions, query),
    [effectiveActions, query],
  );
  const confirmationAction = confirmationId
    ? effectiveActions.find((action) => action.id === confirmationId)
    : undefined;

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setSelectedIndex(0);
    setConfirmationId(null);
    setStatus("");
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      const target = restoreFocusRef.current;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
    };
  }, [open]);

  const rankedIds = ranked.map((action) => action.id).join("\u0000");
  useEffect(() => {
    setSelectedIndex((current) =>
      ranked.length === 0 ? 0 : Math.min(current, ranked.length - 1),
    );
  }, [ranked.length, rankedIds]);

  useEffect(() => {
    if (!confirmationId || confirmationAction) return;
    setConfirmationId(null);
    setStatus("That action is no longer available.");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [confirmationAction, confirmationId]);

  useEffect(() => {
    if (!confirmationAction) return;
    requestAnimationFrame(() => confirmRef.current?.focus());
  }, [confirmationAction]);

  function dismiss(): void {
    setConfirmationId(null);
    onDismiss();
  }

  function choose(action: PaletteAction): void {
    if (!action.enabled) {
      setStatus(action.disabledReason ?? "This action is unavailable.");
      return;
    }
    if (action.confirmation) {
      setConfirmationId(action.id);
      setStatus("");
      return;
    }
    dismiss();
    onExecute(action.id);
  }

  function moveSelection(nextIndex: number): void {
    if (ranked.length === 0) return;
    const normalized = (nextIndex + ranked.length) % ranked.length;
    setSelectedIndex(normalized);
    document.getElementById(optionId(normalized))?.scrollIntoView({
      block: "nearest",
    });
  }

  function handleSearchKeys(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(selectedIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(selectedIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveSelection(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveSelection(ranked.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = ranked[selectedIndex];
      if (action) choose(action);
    }
  }

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirmationId) {
        setConfirmationId(null);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else {
        dismiss();
      }
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  if (!open) return null;

  let previousGroup = "";
  const activeOption = ranked.length > 0 ? optionId(selectedIndex) : undefined;

  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        ref={dialogRef}
        onKeyDown={handleDialogKeys}
      >
        <h2 className="visually-hidden" id="command-palette-title">
          Command palette
        </h2>

        {confirmationAction?.confirmation ? (
          <div className="command-palette__confirmation">
            <span className="command-palette__confirmation-mark" aria-hidden="true">
              ?
            </span>
            <div>
              <span className="eyebrow">Confirm action</span>
              <h3>{confirmationAction.confirmation.title}</h3>
              {confirmationAction.confirmation.message ? (
                <p>{confirmationAction.confirmation.message}</p>
              ) : null}
              <div className="command-palette__confirmation-source">
                <span>{confirmationAction.group}</span>
                {confirmationAction.source ? <code>{confirmationAction.source}</code> : null}
              </div>
            </div>
            <div className="command-palette__confirmation-actions">
              <button
                className="button button--quiet"
                type="button"
                onClick={() => {
                  setConfirmationId(null);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                Cancel
              </button>
              <button
                className="button button--danger"
                type="button"
                ref={confirmRef}
                onClick={() => {
                  const id = confirmationAction.id;
                  dismiss();
                  onExecute(id);
                }}
              >
                {confirmationAction.confirmation.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="command-palette__search">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5" />
                <path d="m12.2 12.2 4 4" />
              </svg>
              <input
                ref={inputRef}
                role="combobox"
                aria-autocomplete="list"
                aria-controls="command-palette-results"
                aria-expanded="true"
                aria-activedescendant={activeOption}
                placeholder="Search actions, dashboards, and commands…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                  setStatus("");
                }}
                onKeyDown={handleSearchKeys}
              />
              <kbd>Esc</kbd>
            </div>

            <div
              className="command-palette__results"
              id="command-palette-results"
              role="listbox"
              aria-label="Available commands"
            >
              {ranked.length === 0 ? (
                <div className="command-palette__empty">
                  <strong>No matching actions</strong>
                  <span>Try a dashboard name, component, or configured command.</span>
                </div>
              ) : (
                ranked.map((action, index) => {
                  const showGroup = action.group !== previousGroup;
                  previousGroup = action.group;
                  return (
                    <div
                      className="command-palette__result"
                      key={action.id}
                      role="presentation"
                    >
                      {showGroup ? (
                        <div
                          className="command-palette__group"
                          aria-hidden="true"
                          role="presentation"
                        >
                          {action.group}
                        </div>
                      ) : null}
                      <button
                        id={optionId(index)}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === selectedIndex}
                        aria-disabled={!action.enabled}
                        className={`command-palette__option${
                          index === selectedIndex ? " command-palette__option--selected" : ""
                        }${!action.enabled ? " command-palette__option--disabled" : ""}`}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => choose(action)}
                      >
                        <span className="command-palette__option-copy">
                          <strong>{action.label}</strong>
                          <span>
                            {!action.enabled
                              ? action.disabledReason
                              : action.description ?? action.source ?? "Ready"}
                          </span>
                        </span>
                        <span className="command-palette__option-meta">
                          {action.source ? <code>{action.source}</code> : null}
                          {action.confirmation ? <span>Confirm</span> : null}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <footer className="command-palette__footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
              <span><kbd>↵</kbd> Run</span>
              <span className="command-palette__count">
                {ranked.length} {ranked.length === 1 ? "action" : "actions"}
              </span>
            </footer>
          </>
        )}
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {status ||
            (confirmationAction
              ? `Confirmation required for ${confirmationAction.label}.`
              : `${ranked.length} ${ranked.length === 1 ? "action" : "actions"} available.`)}
        </div>
      </div>
    </div>
  );
}
