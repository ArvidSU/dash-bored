import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  ProcessSnapshot,
  ProjectListItem,
  ProjectSnapshot,
} from "../../shared/contracts";
import type { AgentSessionState, AgentSessionTask } from "../../shared/agent-session";
import { BUILTIN_THEMES, type ThemeCatalogItem } from "../../shared/themes";
import {
  agentStateNeedsUser,
  boundAgentTasks,
  isAgentStateActive,
  replaceAgentTask,
  sortAgentTasks,
} from "../lib/agent-tasks";
import { host } from "../lib/rpc-client";
import type { ProjectOutlineState } from "./app-shell";
import {
  dashboardKey,
  errorMessage,
  outlineError,
  rememberProject,
  replaceProcess,
} from "./app-utils";
import { useLatestRef } from "./use-latest-ref";

export interface HostSessionHandlers {
  /** The first host read finished; settings seed the renderer's copy. */
  onBoot(settings: AppSettings): void;
  /**
   * An agent task became active, or started waiting on the user; the work
   * surface should open. Other task updates never reopen a dismissed drawer.
   */
  onAgentTaskActivated(): void;
  /** The host asked for the command palette (native menu). */
  onPaletteRequested(): void;
  onError(message: string): void;
}

/**
 * Everything the desktop host owns and pushes: the active snapshot, the
 * registered projects and their outlines, the theme catalog, and agent tasks.
 * The renderer never edits these copies except to apply host results.
 */
export function useHostSession(handlers: HostSessionHandlers) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [outlines, setOutlines] = useState<Record<string, ProjectOutlineState>>({});
  const [themes, setThemes] = useState<ThemeCatalogItem[]>([...BUILTIN_THEMES]);
  const [agentTasks, setAgentTasks] = useState<AgentSessionTask[]>([]);
  const [loading, setLoading] = useState(true);
  const handlersRef = useLatestRef(handlers);
  const snapshotRef = useLatestRef(snapshot);
  // Process output arrives far more often than anything else. Components read
  // it through this ref (so their host objects stay stable) during render, so
  // the host events below write it before the matching snapshot update renders.
  const processesRef = useRef<ReadonlyMap<string, ProcessSnapshot>>(new Map());
  // The last state seen per agent task, from pushes and command results alike.
  const agentTaskStatesRef = useRef(new Map<string, AgentSessionState>());

  useEffect(() => {
    let active = true;
    const taskStates = agentTaskStatesRef.current;
    const pendingProcessEvents = new Map<string, ProcessSnapshot>();
    // Opens Agent work when a task becomes active or starts needing the user
    // (a permission request or sign-in), even if the user dismissed it before.
    const syncAgentActivity = (task: AgentSessionTask, openOnActivation = true): void => {
      const previous = taskStates.get(task.id);
      taskStates.set(task.id, task.state);
      if (!openOnActivation || previous === task.state) return;
      if (agentStateNeedsUser(task.state) || (isAgentStateActive(task.state) && !isAgentStateActive(previous))) {
        handlersRef.current.onAgentTaskActivated();
      }
    };
    // The active project's outline is its snapshot tree; remember it so the
    // sidebar keeps showing it after another project becomes active.
    const rememberOutline = (next: ProjectSnapshot): void => {
      if (!next.configPath) return;
      setOutlines((current) => ({
        ...current,
        [next.configPath!]: { tree: next.tree, loading: false, error: outlineError(next) },
      }));
    };
    let hasSnapshot = false;
    const applySnapshot = (next: ProjectSnapshot): void => {
      hasSnapshot = true;
      processesRef.current = new Map(next.processes.map((process) => [process.id, process]));
      setSnapshot(next);
      rememberOutline(next);
    };

    const unsubscribe = host.subscribe((event) => {
      if (!active) return;
      if (event.type === "themes") {
        setThemes(event.catalog);
      } else if (event.type === "snapshot") {
        applySnapshot(event.snapshot);
        setProjects((current) => rememberProject(current, event.snapshot));
      } else if (event.type === "process") {
        pendingProcessEvents.set(event.process.id, event.process);
        if (hasSnapshot) processesRef.current = new Map(processesRef.current).set(event.process.id, event.process);
        setSnapshot((current) => current ? replaceProcess(current, event.process) : current);
      } else if (event.type === "agent-task") {
        setAgentTasks((current) => replaceAgentTask(current, event.task));
        syncAgentActivity(event.task);
      } else if (event.type === "open-command-palette") {
        handlersRef.current.onPaletteRequested();
      }
    });

    void Promise.all([host.getSnapshot(), host.listProjects(), host.getAppSettings(), host.getAgentTasks()])
      .then(([initialSnapshot, initialProjects, initialSettings, initialAgentTasks]) => {
        if (!active) return;
        const withPendingProcesses = [...pendingProcessEvents.values()].reduce(replaceProcess, initialSnapshot);
        applySnapshot(withPendingProcesses);
        setProjects(rememberProject(initialProjects, initialSnapshot));
        handlersRef.current.onBoot(initialSettings);
        // Pushes that raced the initial read are newer than its copies.
        const initial = boundAgentTasks(sortAgentTasks(initialAgentTasks));
        setAgentTasks((current) => current.reduce(replaceAgentTask, initial));
        for (const task of initialAgentTasks) {
          if (!taskStates.has(task.id)) syncAgentActivity(task, false);
        }
      })
      .catch((error: unknown) => {
        if (active) handlersRef.current.onError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void host.getThemes().then((items) => { if (active) setThemes(items); }).catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [snapshot?.revision]);

  const loadOutline = useCallback((project: ProjectListItem): void => {
    const key = dashboardKey(project);
    setOutlines((current) => ({
      ...current,
      [key]: { tree: current[key]?.tree ?? null, loading: true, error: null },
    }));
    void host.getProjectOutline(project)
      .then((outline) => {
        setOutlines((current) => ({
          ...current,
          [key]: { tree: outline.tree, loading: false, error: outlineError(outline) },
        }));
      })
      .catch((error: unknown) => {
        setOutlines((current) => ({
          ...current,
          [key]: { tree: null, loading: false, error: errorMessage(error) },
        }));
      });
  }, []);

  /**
   * Applies the task a command answered with. The answer carries the task as
   * of when it was sent, on the same ordered channel as pushes, so it is never
   * older than a push that arrived before it. Applying it at once keeps
   * controls off the pre-command state until a later push arrives.
   */
  const applyAgentTask = useCallback((task: AgentSessionTask): void => {
    agentTaskStatesRef.current.set(task.id, task.state);
    setAgentTasks((current) => replaceAgentTask(current, task));
  }, []);

  const forgetOutline = useCallback((configPath: string): void => {
    setOutlines((current) => {
      if (!Object.hasOwn(current, configPath)) return current;
      const next = { ...current };
      delete next[configPath];
      return next;
    });
  }, []);


  return {
    snapshot,
    snapshotRef,
    projects,
    setProjects,
    outlines,
    loadOutline,
    forgetOutline,
    themes,
    agentTasks,
    applyAgentTask,
    processesRef,
    loading,
  };
}

export type HostSession = ReturnType<typeof useHostSession>;
