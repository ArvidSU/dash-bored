import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ResolvedComponentAction } from "../../shared/contracts";
import { actionInvocation } from "../../shared/action-invocation";
import { ActionStore, matchActionChoiceSelections, type ActionProviderSnapshot, type PaletteAction } from "../lib/actions";
import { errorMessage } from "./app-utils";

/** One palette interaction; an invocation carries a caller's arguments into it. */
interface PaletteState {
  open: boolean;
  initialActionId: string | null;
  invocation: {
    actionId: string;
    args: Record<string, unknown>;
    callerNodeId?: string;
    key?: string;
  } | null;
}

const CLOSED_PALETTE: PaletteState = { open: false, initialActionId: null, invocation: null };

/**
 * The window's one action registry: providers register into the store, and
 * every invocation (button, shortcut, palette, agent) runs through it. An
 * action that still needs a choice or confirmation opens the palette.
 */
export function useActionRegistry(setError: (message: string | null) => void) {
  const store = useMemo(() => new ActionStore(), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [palette, setPalette] = useState<PaletteState>(CLOSED_PALETTE);

  const runFromPalette = useCallback(async (
    id: string,
    selections?: Readonly<Record<string, string>>,
    args: Record<string, unknown> = {},
    callerNodeId?: string,
    invocationKey?: string,
  ): Promise<void> => {
    setError(null);
    if (!store.get(id)) {
      setError("This action is no longer available.");
      return;
    }
    const result = await store.run(id, selections, args, callerNodeId, invocationKey ?? id);
    if (result.status === "failed") setError(errorMessage(result.error));
    else if (result.status === "unavailable") setError(result.reason);
    else if (result.status === "running") setError("That action is already running.");
  }, [setError, store]);

  /** Runs a reference with arguments, opening the palette when it needs input. */
  const request = useCallback((
    reference: string,
    args: Record<string, unknown> = {},
    callerNodeId?: string,
    invocationKey?: string,
  ): void => {
    const invocation = actionInvocation(reference);
    if (!invocation) return;
    const actionArgs = { ...invocation.with, ...args };
    const action = store.get(invocation.run);
    if (invocation.run === "agent:prompt") {
      if (action) void store.run(invocation.run, {}, actionArgs, callerNodeId, invocationKey ?? action.id);
      return;
    }
    const selections = action?.choices ? matchActionChoiceSelections(action.choices, actionArgs) : {};
    const missingChoice = action?.choices?.some((choice) => selections[choice.id] === undefined);
    if (action && (missingChoice || action.confirmation)) {
      setPalette({
        open: true,
        initialActionId: action.id,
        invocation: { actionId: action.id, args: actionArgs, callerNodeId, key: invocationKey },
      });
      return;
    }
    void runFromPalette(invocation.run, selections, actionArgs, callerNodeId, invocationKey ?? action?.id);
  }, [runFromPalette, store]);

  /** What builtins and local components resolve and invoke actions through. */
  const controller = useMemo(() => ({
    resolve(reference: string, invocationKey?: string): ResolvedComponentAction {
      return store.resolve(reference, invocationKey);
    },
    invoke(reference: string, args?: Record<string, unknown>, callerNodeId?: string, invocationKey?: string): void {
      request(reference, args, callerNodeId, invocationKey);
    },
  }), [request, store]);

  const invocation = palette.invocation;
  return {
    store,
    controller,
    componentActions: state.componentActions,
    runningActionIds: state.runningActionIds,
    diagnostics: state.diagnostics,
    request,
    palette: {
      open: palette.open,
      initialActionId: palette.initialActionId,
      initialSelections: invocation && invocation.actionId === palette.initialActionId
        ? invocation.args as Readonly<Record<string, string>>
        : {},
      show: () => setPalette((current) => ({ ...current, open: true })),
      showFresh: () => setPalette((current) => ({ ...current, open: true, initialActionId: null })),
      dismiss: () => setPalette(CLOSED_PALETTE),
      execute: (id: string, selections: Readonly<Record<string, string>>) => {
        const forThis = invocation?.actionId === id ? invocation : null;
        void runFromPalette(id, selections, forThis?.args ?? {}, forThis?.callerNodeId, forThis ? forThis.key : id);
        setPalette((current) => ({ ...current, initialActionId: null, invocation: null }));
      },
    },
  };
}

/**
 * Registers the app's action providers and returns every action, providers
 * first. Built during render so dynamic choice options always close over
 * current state; the store's index (refreshed here) serves handlers.
 */
export function useProvidedActions(
  store: ActionStore,
  providers: readonly ActionProviderSnapshot[],
  componentActions: readonly PaletteAction[],
): PaletteAction[] {
  useLayoutEffect(() => {
    store.replaceProviders(providers);
  }, [store, ...providers.map((provider) => provider.actions)]);
  return [...providers.flatMap((provider) => provider.actions), ...componentActions];
}
