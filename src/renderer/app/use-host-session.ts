import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  DashboardAgentTask,
  ProcessSnapshot,
  ProjectListItem,
  ProjectSnapshot,
} from "../../shared/contracts";
import { processRun } from "../../shared/process-state";
import { BUILTIN_THEMES, type ThemeCatalogItem } from "../../shared/themes";
import { host } from "../lib/rpc-client";
import type { ProjectOutlineState } from "./app-shell";
import {
  dashboardKey,
  errorMessage,
  outlineError,
  rememberProject,
  replaceDashboardAgentTask,
  replaceProcess,
  starterDashboardAgentTask,
} from "./app-utils";
import { useLatestRef } from "./use-latest-ref";

const STARTER_TASK_ID = "setup-dashboard-with-agent";

export interface HostSessionHandlers {
  /** The first host read finished; settings seed the renderer's copy. */
  onBoot(settings: AppSettings): void;
  /** An agent task became active; the work surface should open. */
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
  const [agentTasks, setAgentTasks] = useState<DashboardAgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const handlersRef = useLatestRef(handlers);
  const snapshotRef = useLatestRef(snapshot);
  // Process output arrives far more often than anything else. Components read
  // it through this ref (so their host objects stay stable) during render, so
  // the host events below write it before the matching snapshot update renders.
  const processesRef = useRef<ReadonlyMap<string, ProcessSnapshot>>(new Map());

  useEffect(() => {
    let active = true;
    const activeTaskIds = new Set<string>();
    const pendingProcessEvents = new Map<string, ProcessSnapshot>();
    const syncAgentActivity = (
      taskId: string,
      phase: ProcessSnapshot["phase"],
      openOnActivation = true,
    ): void => {
      const isActive = phase === "running" || phase === "stopping";
      const wasActive = activeTaskIds.has(taskId);
      if (!isActive) {
        activeTaskIds.delete(taskId);
        return;
      }
      activeTaskIds.add(taskId);
      if (openOnActivation && !wasActive) handlersRef.current.onAgentTaskActivated();
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
    const starterTask = (next: ProjectSnapshot) => next.processes
      .map((process) => starterDashboardAgentTask(next.configPath, process))
      .find((task): task is DashboardAgentTask => task !== null);

    const unsubscribe = host.subscribe((event) => {
      if (!active) return;
      if (event.type === "themes") {
        setThemes(event.catalog);
      } else if (event.type === "snapshot") {
        applySnapshot(event.snapshot);
        const starter = starterTask(event.snapshot);
        if (starter) setAgentTasks((current) => replaceDashboardAgentTask(current, starter));
        syncAgentActivity(STARTER_TASK_ID, starter?.process.phase ?? "idle", false);
        setProjects((current) => rememberProject(current, event.snapshot));
      } else if (event.type === "process") {
        pendingProcessEvents.set(event.process.id, event.process);
        if (hasSnapshot) processesRef.current = new Map(processesRef.current).set(event.process.id, event.process);
        setSnapshot((current) => current ? replaceProcess(current, event.process) : current);
        if (event.process.id === STARTER_TASK_ID) {
          const starter = starterDashboardAgentTask(snapshotRef.current?.configPath, event.process);
          setAgentTasks((current) => starter
            ? replaceDashboardAgentTask(current, starter)
            : current.filter((task) => task.id !== event.process.id));
          syncAgentActivity(event.process.id, event.process.phase);
        }
      } else if (event.type === "agent-task") {
        setAgentTasks((current) => replaceDashboardAgentTask(current, event.task));
        syncAgentActivity(event.task.id, processRun(event.task.process)?.phase ?? "idle");
      } else {
        handlersRef.current.onPaletteRequested();
      }
    });

    void Promise.all([host.getSnapshot(), host.listProjects(), host.getAppSettings(), host.getDashboardAgentTasks()])
      .then(([initialSnapshot, initialProjects, initialSettings, initialAgentTasks]) => {
        if (!active) return;
        const withPendingProcesses = [...pendingProcessEvents.values()].reduce(replaceProcess, initialSnapshot);
        applySnapshot(withPendingProcesses);
        const starter = starterTask(withPendingProcesses);
        setProjects(rememberProject(initialProjects, initialSnapshot));
        handlersRef.current.onBoot(initialSettings);
        setAgentTasks((current) => {
          const withStarter = starter ? replaceDashboardAgentTask(initialAgentTasks, starter) : initialAgentTasks;
          return current.reduce(replaceDashboardAgentTask, withStarter);
        });
        for (const task of initialAgentTasks) {
          syncAgentActivity(task.id, processRun(task.process)?.phase ?? "idle", false);
        }
        if (starter) syncAgentActivity(starter.id, starter.process.phase, false);
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
    processesRef,
    loading,
  };
}

export type HostSession = ReturnType<typeof useHostSession>;
