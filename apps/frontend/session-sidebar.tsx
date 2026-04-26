import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { SessionInfo } from "../../packages/shared/types";
import {
  projectFilterValue,
  projectLabel,
  providerFilterValue,
  providerLabel,
  relativeActivityLabel,
  sessionActivityLabel,
  sessionActivityTimestamp,
  sessionActivityTitle,
  sessionDisplayTitle,
  sessionSourceTitle,
} from "./session-utils";
import { SIDEBAR_TREE_STORAGE_KEY } from "./storage-prefs";

const DEFAULT_PROJECT_LIMIT = 5;
const PROJECT_LIMIT_STEP = 5;
const DEFAULT_SESSION_LIMIT = 5;
const SESSION_LIMIT_STEP = 10;

type TreePrefs = {
  open?: Record<string, boolean>;
  projectLimits?: Record<string, number>;
  sessionLimits?: Record<string, number>;
};

type DeviceNode = {
  key: string;
  label: string;
  title: string;
  count: number;
  archivedCount: number;
  updatedAt: string;
  providers: ProviderNode[];
};

type ProviderNode = {
  key: string;
  value: string;
  label: string;
  count: number;
  archivedCount: number;
  updatedAt: string;
  projects: ProjectNode[];
};

type ProjectNode = {
  key: string;
  value: string;
  label: string;
  count: number;
  archivedCount: number;
  updatedAt: string;
  sessions: SessionInfo[];
};

export function SessionSidebar({
  sidebarOpen,
  sidebarRef,
  active,
  query,
  sessions,
  filteredSessionCount,
  groupByProject,
  onClose,
  onResizePointerDown,
  onResizeKeyDown,
  onQueryChange,
  onSelectSession,
}: {
  sidebarOpen: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
  active: SessionInfo | null;
  query: string;
  sessions: SessionInfo[];
  filteredSessionCount: number;
  groupByProject: boolean;
  onClose: () => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onQueryChange: (value: string) => void;
  onSelectSession: (session: SessionInfo) => void;
}) {
  const [treePrefs, setTreePrefs] = useState<TreePrefs>(readTreePrefs);
  const tree = useMemo(() => buildTree(sessions, groupByProject), [groupByProject, sessions]);

  useEffect(() => {
    writeTreePrefs(treePrefs);
  }, [treePrefs]);

  const hasQuery = query.trim().length > 0;
  const isOpen = useCallback((key: string) => (hasQuery ? true : treePrefs.open?.[key] ?? true), [hasQuery, treePrefs.open]);
  const toggleOpen = useCallback((key: string) => {
    setTreePrefs((current) => ({ ...current, open: { ...current.open, [key]: !(current.open?.[key] ?? true) } }));
  }, []);
  const projectLimit = useCallback((key: string) => treePrefs.projectLimits?.[key] ?? DEFAULT_PROJECT_LIMIT, [treePrefs.projectLimits]);
  const sessionLimit = useCallback((key: string) => treePrefs.sessionLimits?.[key] ?? DEFAULT_SESSION_LIMIT, [treePrefs.sessionLimits]);
  const showMoreProjects = useCallback((key: string) => {
    setTreePrefs((current) => ({
      ...current,
      projectLimits: {
        ...current.projectLimits,
        [key]: (current.projectLimits?.[key] ?? DEFAULT_PROJECT_LIMIT) + PROJECT_LIMIT_STEP,
      },
    }));
  }, []);
  const showMoreSessions = useCallback((key: string) => {
    setTreePrefs((current) => ({
      ...current,
      sessionLimits: {
        ...current.sessionLimits,
        [key]: (current.sessionLimits?.[key] ?? DEFAULT_SESSION_LIMIT) + SESSION_LIMIT_STEP,
      },
    }));
  }, []);

  return (
    <>
      {sidebarOpen && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close chats" />}
      <aside className="sidebar" ref={sidebarRef}>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />

        <div className="sidebar-search">
          <input
            className="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search chats"
            autoCapitalize="none"
          />
          <span>{filteredSessionCount.toLocaleString()}</span>
        </div>

        <div className="session-list tree-list">
          {tree.length === 0 && <div className="empty-tree">No matching chats</div>}
          {tree.map((device) => {
            const deviceOpen = isOpen(device.key);
            return (
              <div key={device.key} className="tree-node">
                <FolderRow nodeKey={device.key} level={0} label={device.label} title={device.title} count={device.count} updatedAt={device.updatedAt} open={deviceOpen} archivedCount={device.archivedCount} onToggle={toggleOpen} />
                {deviceOpen &&
                  device.providers.map((provider) => {
                    const providerOpen = isOpen(provider.key);
                    const visibleProjects = takeWithActiveProject(provider.projects, projectLimit(provider.key), active);
                    const hiddenProjects = Math.max(0, provider.projects.length - visibleProjects.length);
                    return (
                      <div key={provider.key} className="tree-node">
                        <FolderRow nodeKey={provider.key} level={1} label={provider.label} count={provider.count} updatedAt={provider.updatedAt} open={providerOpen} archivedCount={provider.archivedCount} onToggle={toggleOpen} />
                        {providerOpen && (
                          <>
                            {visibleProjects.map((project) => {
                              const projectOpen = isOpen(project.key);
                              const visibleSessions = takeWithActiveSession(project.sessions, sessionLimit(project.key), active);
                              const hiddenSessions = Math.max(0, project.sessions.length - visibleSessions.length);
                              return (
                                <div key={project.key} className="tree-node">
                                  <FolderRow nodeKey={project.key} level={2} label={project.label} count={project.count} updatedAt={project.updatedAt} open={projectOpen} archivedCount={project.archivedCount} onToggle={toggleOpen} />
                                  {projectOpen && (
                                    <>
                                      {visibleSessions.map((session) => (
                                        <button
                                          key={session.id}
                                          className={`tree-row tree-session level-3 ${active?.id === session.id ? "active" : ""}`}
                                          onClick={() => onSelectSession(session)}
                                          title={sessionSourceTitle(session)}
                                        >
                                          <span className={`archive-dot ${session.deletedAt ? "archived" : "active"}`} title={session.deletedAt ? "Archived" : "Active"} />
                                          <span className="tree-label">{sessionDisplayTitle(session)}</span>
                                          <span className="tree-time" title={sessionActivityTitle(session)}>
                                            {sessionActivityLabel(session)}
                                          </span>
                                        </button>
                                      ))}
                                      {hiddenSessions > 0 && (
                                        <button className="tree-show-more level-3" onClick={() => showMoreSessions(project.key)}>
                                          Show more
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              );
                            })}
                            {hiddenProjects > 0 && (
                              <button className="tree-show-more level-2" onClick={() => showMoreProjects(provider.key)}>
                                Show more projects
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}

function FolderRow({
  nodeKey,
  level,
  label,
  title,
  count,
  updatedAt,
  open,
  archivedCount,
  onToggle,
}: {
  nodeKey: string;
  level: 0 | 1 | 2;
  label: string;
  title?: string;
  count: number;
  updatedAt: string;
  open: boolean;
  archivedCount: number;
  onToggle: (key: string) => void;
}) {
  return (
    <button className={`tree-row tree-folder level-${level} ${open ? "open" : ""}`} onClick={() => onToggle(nodeKey)} title={title}>
      <span className="tree-chevron">{open ? "v" : ">"}</span>
      <span className="tree-label">{label}</span>
      <span className="tree-meta">
        {archivedCount > 0 && <span className="archive-dot archived" title={`${archivedCount.toLocaleString()} archived`} />}
        {count.toLocaleString()}
        {updatedAt ? ` · ${relativeActivityLabel(updatedAt)}` : ""}
      </span>
    </button>
  );
}

function buildTree(sessions: SessionInfo[], groupByProject: boolean): DeviceNode[] {
  const devices = new Map<string, MutableDeviceNode>();
  for (const session of sessions) {
    const deviceKey = deviceTreeKey(session);
    let device = devices.get(deviceKey);
    if (!device) {
      device = {
        key: deviceKey,
        label: session.hostname || "Unknown device",
        title: session.hostname || "Unknown device",
        count: 0,
        archivedCount: 0,
        updatedAt: "",
        agentIds: new Set(),
        providers: new Map(),
      };
      devices.set(deviceKey, device);
    }
    device.agentIds.add(session.agentId);

    const providerValue = providerFilterValue(session);
    const providerKey = `${deviceKey}:provider:${providerValue}`;
    let provider = device.providers.get(providerKey);
    if (!provider) {
      provider = {
        key: providerKey,
        value: providerValue,
        label: providerLabel(providerValue),
        count: 0,
        archivedCount: 0,
        updatedAt: "",
        projects: new Map(),
      };
      device.providers.set(providerKey, provider);
    }

    const projectValue = groupByProject ? projectFilterValue(session) : "recent";
    const projectKey = `${providerKey}:project:${projectValue}`;
    let project = provider.projects.get(projectKey);
    if (!project) {
      project = {
        key: projectKey,
        value: projectValue,
        label: groupByProject ? projectLabel(session) : "Recent",
        count: 0,
        archivedCount: 0,
        updatedAt: "",
        sessions: [],
      };
      provider.projects.set(projectKey, project);
    }

    const timestamp = sessionActivityTimestamp(session) ?? "";
    const archived = Boolean(session.deletedAt);
    device.count += 1;
    provider.count += 1;
    project.count += 1;
    if (archived) {
      device.archivedCount += 1;
      provider.archivedCount += 1;
      project.archivedCount += 1;
    }
    if (timestamp > device.updatedAt) device.updatedAt = timestamp;
    if (timestamp > provider.updatedAt) provider.updatedAt = timestamp;
    if (timestamp > project.updatedAt) project.updatedAt = timestamp;
    project.sessions.push(session);
  }

  return [...devices.values()]
    .map((device) => ({
      ...device,
      title: [`${device.label}`, ...[...device.agentIds].sort()].join("\n"),
      providers: [...device.providers.values()]
        .map((provider) => ({
          ...provider,
          projects: [...provider.projects.values()]
            .map((project) => ({
              ...project,
              sessions: project.sessions.sort(compareSessions),
            }))
            .sort(compareProjects),
        }))
        .sort(compareProviders),
    }))
    .sort(compareDevices);
}

type MutableDeviceNode = Omit<DeviceNode, "providers"> & { providers: Map<string, MutableProviderNode>; agentIds: Set<string> };
type MutableProviderNode = Omit<ProviderNode, "projects"> & { projects: Map<string, ProjectNode> };

function deviceTreeKey(session: SessionInfo) {
  const hostname = session.hostname.trim().toLowerCase();
  return hostname ? `device:host:${hostname}` : `device:agent:${session.agentId}`;
}

function compareDevices(a: DeviceNode, b: DeviceNode) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.label.localeCompare(b.label);
}

function compareProviders(a: ProviderNode, b: ProviderNode) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.label.localeCompare(b.label);
}

function compareProjects(a: ProjectNode, b: ProjectNode) {
  const aActive = a.count - a.archivedCount;
  const bActive = b.count - b.archivedCount;
  if (aActive > 0 !== bActive > 0) return bActive - aActive;
  return b.updatedAt.localeCompare(a.updatedAt) || a.label.localeCompare(b.label);
}

function compareSessions(a: SessionInfo, b: SessionInfo) {
  if (Boolean(a.deletedAt) !== Boolean(b.deletedAt)) return a.deletedAt ? 1 : -1;
  return (sessionActivityTimestamp(b) ?? "").localeCompare(sessionActivityTimestamp(a) ?? "");
}

function takeWithActiveProject(projects: ProjectNode[], limit: number, active: SessionInfo | null) {
  const visible = projects.slice(0, Math.max(0, limit));
  if (!active) return visible;
  const activeProject = projects.find((project) => project.sessions.some((session) => session.id === active.id));
  if (activeProject && !visible.some((project) => project.key === activeProject.key)) visible.push(activeProject);
  return visible;
}

function takeWithActiveSession(sessions: SessionInfo[], limit: number, active: SessionInfo | null) {
  const visible = sessions.slice(0, Math.max(0, limit));
  if (!active) return visible;
  const activeSession = sessions.find((session) => session.id === active.id);
  if (activeSession && !visible.some((session) => session.id === activeSession.id)) visible.push(activeSession);
  return visible;
}

function readTreePrefs(): TreePrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_TREE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TreePrefs;
    return {
      open: objectOfBooleans(parsed.open),
      projectLimits: objectOfNumbers(parsed.projectLimits),
      sessionLimits: objectOfNumbers(parsed.sessionLimits),
    };
  } catch {
    return {};
  }
}

function writeTreePrefs(value: TreePrefs) {
  try {
    localStorage.setItem(SIDEBAR_TREE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    return;
  }
}

function objectOfBooleans(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "boolean") out[key] = item;
  }
  return out;
}

function objectOfNumbers(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) out[key] = Math.floor(item);
  }
  return out;
}
