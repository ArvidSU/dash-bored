import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { PaletteAction, PaletteEntry } from "../lib/actions";
import { matchActionChoiceSelections, rankActionChoiceOptions, rankPaletteEntries, resolveActionChoiceOptions } from "../lib/actions";
import type { ComponentActionOption, ComponentActionSelections } from "../../shared/contracts";
import { keyboardShortcutLabel } from "../../shared/keyboard-shortcut";

interface CommandPaletteProps {
  open: boolean;
  actions: readonly PaletteAction[];
  runningActionIds: ReadonlySet<string>;
  favoriteActionIds: ReadonlySet<string>;
  actionShortcuts: Readonly<Record<string, string>>;
  favoritesDisabled: boolean;
  clearInputOnKeepOpen: boolean;
  executionError?: string | null;
  initialActionId?: string | null;
  initialSelections?: ComponentActionSelections;
  onDismiss(): void;
  onExecute(id: string, selections?: ComponentActionSelections): void;
  onToggleFavorite(id: string): void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'input, button:not([disabled]):not([tabindex="-1"]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function optionId(index: number): string {
  return `command-palette-option-${index}`;
}

/** Labels of the options already chosen before `step`, for the chooser breadcrumb. */
function chosenLabels(action: PaletteAction, selections: ComponentActionSelections, step: number): string[] {
  return (action.choices ?? []).slice(0, step).flatMap((choice) => {
    const value = selections[choice.id];
    if (value === undefined) return [];
    try {
      return [resolveActionChoiceOptions(choice, selections).find((option) => option.value === value)?.label ?? value];
    } catch {
      return [value];
    }
  });
}

export function CommandPalette({
  open,
  actions,
  runningActionIds,
  favoriteActionIds,
  actionShortcuts,
  favoritesDisabled,
  clearInputOnKeepOpen,
  executionError,
  initialActionId,
  initialSelections = {},
  onDismiss,
  onExecute,
  onToggleFavorite,
}: CommandPaletteProps): ReactNode {
  // One search input serves every step; the action search waits here while a chooser is open.
  const [query, setQuery] = useState("");
  const [rootQuery, setRootQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [choiceActionId, setChoiceActionId] = useState<string | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [choices, setChoices] = useState<ComponentActionSelections>({});
  const [status, setStatus] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const keepOpenRef = useRef(false);
  const rootSelectedIndexRef = useRef(0);

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
  const confirmationAction = confirmationId
    ? effectiveActions.find((action) => action.id === confirmationId)
    : undefined;
  const choiceAction = choiceActionId ? effectiveActions.find((action) => action.id === choiceActionId) : undefined;
  const currentChoice = confirmationId ? undefined : choiceAction?.choices?.[choiceIndex];
  const choosing = Boolean(choiceAction && currentChoice);
  const { choiceOptions, choiceError } = useMemo(() => {
    if (!currentChoice) return { choiceOptions: [] as readonly ComponentActionOption[], choiceError: "" };
    try {
      return { choiceOptions: resolveActionChoiceOptions(currentChoice, choices), choiceError: "" };
    } catch (error) {
      return {
        choiceOptions: [] as readonly ComponentActionOption[],
        choiceError: error instanceof Error ? error.message : "This action has no usable options.",
      };
    }
  }, [currentChoice, choices]);
  const entries = useMemo(
    () => (choosing ? [] : rankPaletteEntries(effectiveActions, query, favoriteActionIds)),
    [choosing, effectiveActions, favoriteActionIds, query],
  );
  const rankedChoiceOptions = useMemo(
    () => (choosing ? rankActionChoiceOptions(choiceOptions, query) : []),
    [choosing, choiceOptions, query],
  );
  const rowCount = choosing ? rankedChoiceOptions.length : entries.length;
  const rowKeys = (choosing ? rankedChoiceOptions.map((option) => option.value) : entries.map((entry) => entry.key))
    .join("\u0000");

  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setRootQuery("");
    setSelectedIndex(0);
    setConfirmationId(null);
    setChoiceActionId(null);
    setChoiceIndex(0);
    setChoices({});
    setStatus("");
    keepOpenRef.current = false;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      const target = restoreFocusRef.current;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !initialActionId) return;
    const action = effectiveActions.find((candidate) => candidate.id === initialActionId);
    if (!action?.enabled) return;
    if (action.choices?.length) {
      setChoiceActionId(action.id);
      const matched = matchActionChoiceSelections(action.choices, initialSelections);
      const firstMissing = action.choices.findIndex((choice) => matched[choice.id] === undefined);
      setChoiceIndex(firstMissing < 0 ? action.choices.length - 1 : firstMissing);
      setChoices(matched);
      if (firstMissing < 0) {
        if (action.confirmation) {
          // Past the last choice, matching the manual path, so confirmation renders.
          setChoiceIndex(action.choices.length);
          setConfirmationId(action.id);
          return;
        }
        dismiss();
        onExecute(action.id, matched);
        return;
      }
    } else if (action.confirmation) {
      setConfirmationId(action.id);
    }
  }, [effectiveActions, initialActionId, open]);

  useEffect(() => {
    setSelectedIndex((current) => (rowCount === 0 ? 0 : Math.min(current, rowCount - 1)));
  }, [rowCount, rowKeys]);

  useEffect(() => {
    if (!choiceActionId || choiceAction) return;
    setChoiceActionId(null);
    setChoiceIndex(0);
    setChoices({});
    setQuery(rootQuery);
    setStatus("That action is no longer available.");
  }, [choiceAction, choiceActionId]);

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

  useLayoutEffect(() => {
    // Every step keeps keyboard focus in the one search input.
    if (open && !confirmationId) inputRef.current?.focus();
  }, [open, choiceActionId, choiceIndex, confirmationId]);

  function dismiss(): void {
    keepOpenRef.current = false;
    setConfirmationId(null);
    setChoiceActionId(null);
    setChoices({});
    onDismiss();
  }

  function execute(id: string, selections?: ComponentActionSelections, keepOpen = keepOpenRef.current): void {
    if (keepOpen) {
      keepOpenRef.current = false;
      setConfirmationId(null);
      setChoiceActionId(null);
      setChoiceIndex(0);
      setChoices({});
      if (clearInputOnKeepOpen) {
        setQuery("");
        setSelectedIndex(0);
      } else if (choiceActionId) {
        setQuery(rootQuery);
        setSelectedIndex(rootSelectedIndexRef.current);
      }
      setStatus("Action invoked. Choose another action.");
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      dismiss();
    }
    onExecute(id, selections);
  }

  /** Continue an action from `fromStep`: the next unanswered choice, its confirmation, or the run. */
  function proceed(action: PaletteAction, selections: ComponentActionSelections, fromStep: number, carriedQuery = ""): void {
    const steps = action.choices ?? [];
    let step = fromStep;
    while (step < steps.length && selections[steps[step]!.id] !== undefined) step += 1;
    if (steps.length > 0 && !choiceActionId) {
      setRootQuery(query);
      rootSelectedIndexRef.current = selectedIndex;
    }
    setStatus("");
    if (step < steps.length) {
      setChoiceActionId(action.id);
      setChoiceIndex(step);
      setChoices(selections);
      setQuery(carriedQuery);
      setSelectedIndex(0);
    } else if (action.confirmation) {
      if (steps.length > 0) {
        setChoiceActionId(action.id);
        setChoiceIndex(steps.length);
        setChoices(selections);
      }
      setConfirmationId(action.id);
    } else {
      execute(action.id, steps.length > 0 ? selections : undefined);
    }
  }

  function chooseEntry(entry: PaletteEntry, keepOpen = false): void {
    const { action } = entry;
    if (!action.enabled) {
      setStatus(action.disabledReason ?? "This action is unavailable.");
      return;
    }
    keepOpenRef.current = keepOpen;
    if (entry.kind === "option") {
      proceed(action, { [entry.choice.id]: entry.option.value }, 0);
    } else {
      // A chooser reached through its matching options opens already filtered by that search.
      proceed(action, {}, 0, entry.optionMatches ? query : "");
    }
  }

  function chooseOption(option: ComponentActionOption, keepOpen = false): void {
    if (!choiceAction || !currentChoice) return;
    keepOpenRef.current ||= keepOpen;
    proceed(choiceAction, { ...choices, [currentChoice.id]: option.value }, choiceIndex + 1);
  }

  function activate(index: number, keepOpen = false): void {
    if (choosing) {
      const option = rankedChoiceOptions[index];
      if (option) chooseOption(option, keepOpen);
      return;
    }
    const entry = entries[index];
    if (entry) chooseEntry(entry, keepOpen);
  }

  /** Escape, Backspace in an empty chooser, and the breadcrumb all step back the same way. */
  function goBack(): void {
    if (confirmationId) {
      setConfirmationId(null);
      if (choiceAction?.choices?.length) {
        setChoiceIndex(choiceAction.choices.length - 1);
      } else {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } else if (choiceActionId) {
      if (choiceIndex > 0) {
        setChoiceIndex((index) => index - 1);
        setQuery("");
        setSelectedIndex(0);
      } else {
        setChoiceActionId(null);
        setChoices({});
        setQuery(rootQuery);
        setSelectedIndex(rootSelectedIndexRef.current);
      }
      setStatus("");
    } else {
      dismiss();
    }
  }

  function moveSelection(nextIndex: number): void {
    if (rowCount === 0) return;
    const normalized = (nextIndex + rowCount) % rowCount;
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
      moveSelection(rowCount - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(selectedIndex, event.metaKey);
    } else if (event.key === "Backspace" && query === "" && choiceActionId) {
      event.preventDefault();
      goBack();
    }
  }

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      goBack();
      return;
    }
    if (event.key === "Enter" && event.metaKey && event.target === confirmRef.current) {
      event.preventDefault();
      event.stopPropagation();
      keepOpenRef.current = true;
      confirmRef.current?.click();
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

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const activeOption = rowCount > 0 ? optionId(selectedIndex) : undefined;
  const searching = query.trim() !== "";

  function optionButton(
    index: number,
    content: { label: ReactNode; detail?: string; disabled?: boolean; meta?: ReactNode },
  ): ReactNode {
    const selected = index === selectedIndex;
    return (
      <button
        id={optionId(index)}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={content.disabled || undefined}
        className={`command-palette__option${selected ? " command-palette__option--selected" : ""}${
          content.disabled ? " command-palette__option--disabled" : ""
        }`}
        onMouseMove={(event) => {
          // Opening, filtering, and scrolling can put a row under a stationary cursor.
          if (event.movementX !== 0 || event.movementY !== 0) setSelectedIndex(index);
        }}
        onClick={(event) => activate(index, event.metaKey)}
      >
        <span className="command-palette__option-copy">
          <strong>{content.label}</strong>
          {content.detail ? <span>{content.detail}</span> : null}
        </span>
        {content.meta ? <span className="command-palette__option-meta">{content.meta}</span> : null}
      </button>
    );
  }

  function actionRows(): ReactNode {
    let previousGroup = "";
    return entries.map((entry, index) => {
      const { action } = entry;
      const favorite = entry.kind === "action" && favoriteActionIds.has(action.id);
      // Relevance order interleaves groups while searching, so headings only describe the full list.
      const displayGroup = searching ? "" : favorite ? "Favorites" : action.group;
      const showGroup = displayGroup !== "" && displayGroup !== previousGroup;
      previousGroup = displayGroup;
      const shortcut = entry.kind === "action" ? actionShortcuts[action.id] : undefined;
      const row = entry.kind === "option"
        ? optionButton(index, {
            label: (
              <>
                <span className="command-palette__option-parent">{action.label}</span>
                <span className="command-palette__option-separator" aria-hidden="true">›</span>
                <span className="visually-hidden">: </span>
                {entry.option.label}
              </>
            ),
            detail: action.enabled ? entry.option.description : action.disabledReason,
            disabled: !action.enabled,
          })
        : optionButton(index, {
            label: action.label,
            detail: !action.enabled
              ? [action.disabledReason, action.declaredOnly ? action.source : undefined].filter(Boolean).join(" · ")
              : entry.optionMatches
                ? `${entry.optionMatches} matching options`
                : action.description,
            disabled: !action.enabled,
            meta: shortcut || action.confirmation ? (
              <>
                {shortcut ? <kbd>{keyboardShortcutLabel(shortcut, mac)}</kbd> : null}
                {action.confirmation ? <span>Confirm</span> : null}
              </>
            ) : undefined,
          });
      return (
        <div className="command-palette__result" key={entry.key} role="presentation">
          {showGroup ? (
            <div className="command-palette__group" aria-hidden="true" role="presentation">
              {displayGroup}
            </div>
          ) : null}
          <div className={`command-palette__option-row${index === selectedIndex ? " command-palette__option-row--selected" : ""}`}>
            {row}
            {entry.kind === "action" ? (
              <button
                className={`command-palette__favorite${favorite ? " command-palette__favorite--active" : ""}`}
                type="button"
                aria-label={`${favorite ? "Remove" : "Add"} ${action.label} ${favorite ? "from" : "to"} favorites`}
                aria-pressed={favorite}
                disabled={favoritesDisabled}
                title={favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={() => onToggleFavorite(action.id)}
              >
                <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
              </button>
            ) : <span className="command-palette__favorite-spacer" aria-hidden="true" />}
          </div>
        </div>
      );
    });
  }

  function choiceRows(): ReactNode {
    return rankedChoiceOptions.map((option, index) => (
      <div className="command-palette__result" key={option.value} role="presentation">
        <div className="command-palette__option-row command-palette__option-row--plain">
          {optionButton(index, { label: option.label, detail: option.description })}
        </div>
      </div>
    ));
  }

  const breadcrumb = choosing && choiceAction
    ? [choiceAction.label, ...chosenLabels(choiceAction, choices, choiceIndex)].join(" › ")
    : "";

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
              <button className="button button--quiet" type="button" onClick={goBack}>
                Cancel
              </button>
              <button
                className="button button--danger"
                type="button"
                ref={confirmRef}
                onClick={(event) => {
                  const id = confirmationAction.id;
                  const selections = choices;
                  execute(id, selections, keepOpenRef.current || event.metaKey);
                }}
              >
                {confirmationAction.confirmation.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="command-palette__search">
              {choosing ? (
                <button
                  className="command-palette__crumb"
                  type="button"
                  title="Back (Esc)"
                  onClick={() => {
                    goBack();
                    inputRef.current?.focus();
                  }}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="m11.5 5.5-4.5 4.5 4.5 4.5" />
                  </svg>
                  <span className="visually-hidden">Back: </span>
                  <span className="command-palette__crumb-label">{breadcrumb}</span>
                </button>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5" />
                  <path d="m12.2 12.2 4 4" />
                </svg>
              )}
              <input
                ref={inputRef}
                role="combobox"
                aria-autocomplete="list"
                aria-controls="command-palette-results"
                aria-expanded="true"
                aria-activedescendant={activeOption}
                aria-label={choosing ? `Search ${currentChoice!.label.toLocaleLowerCase()} options` : "Search actions and commands"}
                placeholder={choosing ? `${currentChoice!.label}…` : "Search actions and commands…"}
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

            {executionError ? <p role="alert">{executionError}</p> : null}

            <div
              className="command-palette__results"
              id="command-palette-results"
              role="listbox"
              aria-label={choosing ? currentChoice!.label : "Available commands"}
            >
              {choosing && choiceError ? (
                <div className="command-palette__empty" role="alert">
                  <strong>No options available</strong>
                  <span>{choiceError}</span>
                </div>
              ) : rowCount === 0 ? (
                <div className="command-palette__empty">
                  <strong>{choosing ? "No matching options" : "No matching actions"}</strong>
                  <span>
                    {choosing
                      ? "Try another name or ID."
                      : "Try a component, configured command, or app control."}
                  </span>
                </div>
              ) : choosing ? choiceRows() : actionRows()}
            </div>

            <footer className="command-palette__footer">
              <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
              <span><kbd>↵</kbd> {choosing ? "Select" : "Run"}</span>
              {choosing
                ? <span><kbd>Esc</kbd> Back</span>
                : <span><kbd>⌘↵</kbd> Run and keep open</span>}
              <span className="command-palette__count">
                {choosing
                  ? `${rankedChoiceOptions.length} of ${choiceOptions.length} ${choiceOptions.length === 1 ? "option" : "options"}`
                  : `${entries.length} ${entries.length === 1 ? "result" : "results"}`}
              </span>
            </footer>
          </>
        )}
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {status ||
            (confirmationAction
              ? `Confirmation required for ${confirmationAction.label}.`
              : choosing
                ? `${rankedChoiceOptions.length} ${rankedChoiceOptions.length === 1 ? "option" : "options"} available.`
                : `${entries.length} ${entries.length === 1 ? "result" : "results"} available.`)}
        </div>
      </div>
    </div>
  );
}
