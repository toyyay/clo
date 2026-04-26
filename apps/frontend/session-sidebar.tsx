import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  UIEvent,
} from "react";
import type { SessionInfo } from "../../packages/shared/types";
import {
  hostLabel,
  projectLabel,
  relativeActivityLabel,
  sessionActivityLabel,
  sessionActivityTitle,
  sessionDisplayTitle,
  sessionSourceTitle,
  shortId,
  sourceGenerationLabel,
  sourceProviderLabel,
} from "./session-utils";

export type SidebarFilterOption = {
  value: string;
  label: string;
  count: number;
  title?: string;
};

export type SidebarSessionGroup = {
  key: string;
  title: string;
  sessions: SessionInfo[];
  total: number;
  updatedAt?: string;
};

export function SessionSidebar({
  sidebarOpen,
  sidebarRef,
  activeHost,
  activeProvider,
  activeProject,
  active,
  query,
  providerOptions,
  deviceOptions,
  projectOptions,
  groupedSessions,
  filteredSessionCount,
  visibleSessionCount,
  hiddenSessionCount,
  duplicateHostnames,
  onClose,
  onResizePointerDown,
  onResizeKeyDown,
  onQueryChange,
  onProviderChange,
  onHostChange,
  onProjectChange,
  onSessionListScroll,
  onLoadMore,
  onSelectSession,
}: {
  sidebarOpen: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
  activeHost: string;
  activeProvider: string;
  activeProject: string;
  active: SessionInfo | null;
  query: string;
  providerOptions: SidebarFilterOption[];
  deviceOptions: SidebarFilterOption[];
  projectOptions: SidebarFilterOption[];
  groupedSessions: SidebarSessionGroup[];
  filteredSessionCount: number;
  visibleSessionCount: number;
  hiddenSessionCount: number;
  duplicateHostnames: Set<string>;
  onClose: () => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onQueryChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onHostChange: (value: string) => void;
  onProjectChange: (value: string) => void;
  onSessionListScroll: (event: UIEvent<HTMLDivElement>) => void;
  onLoadMore: () => void;
  onSelectSession: (session: SessionInfo) => void;
}) {
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

        <div className="filter-panel">
          <input
            className="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search chats"
            autoCapitalize="none"
          />

          <div className="filter-section">
            <div className="filter-label">
              <span>Source</span>
              <span>{filteredSessionCount.toLocaleString()}</span>
            </div>
            <div className="filter-grid">
              {providerOptions.map((option) => (
                <button
                  key={option.value}
                  className={`filter-chip ${activeProvider === option.value ? "active" : ""}`}
                  onClick={() => onProviderChange(option.value)}
                >
                  <span>{option.label}</span>
                  <b>{option.count.toLocaleString()}</b>
                </button>
              ))}
            </div>
          </div>

          {projectOptions.length > 1 && (
            <div className="filter-section">
              <div className="filter-label">
                <span>Codex projects</span>
                <span>top {Math.max(0, projectOptions.length - 1)}</span>
              </div>
              <div className="filter-grid project-filter-grid">
                {projectOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`filter-chip ${activeProject === option.value ? "active" : ""}`}
                    onClick={() => onProjectChange(option.value)}
                    title={option.title}
                  >
                    <span>{option.label}</span>
                    <b>{option.count.toLocaleString()}</b>
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="filter-section">
            <div className="filter-label">
              <span>Device</span>
              <span>{activeHost === "all" ? "all" : shortId(activeHost)}</span>
            </div>
            <select className="filter-select" value={activeHost} onChange={(event) => onHostChange(event.target.value)}>
              {deviceOptions.map((option) => (
                <option key={option.value} value={option.value} title={option.title}>
                  {option.label} ({option.count.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="device-strip">
          {deviceOptions.map((option) => (
            <button
              key={option.value}
              className={`host-chip ${activeHost === option.value ? "active" : ""}`}
              onClick={() => onHostChange(option.value)}
              title={option.title}
            >
              {option.label}
              <span>{option.count.toLocaleString()}</span>
            </button>
          ))}
        </div>

        <div className="session-list" onScroll={onSessionListScroll}>
          {groupedSessions.map((group) => (
            <div key={group.key} className="session-group">
              <div className="session-group-head">
                <span>{group.title}</span>
                <span>
                  {group.sessions.length}
                  {group.total > group.sessions.length ? `/${group.total}` : ""}
                  {group.updatedAt ? ` · ${relativeActivityLabel(group.updatedAt)}` : ""}
                </span>
              </div>
              {group.sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item ${active?.id === session.id ? "active" : ""}`}
                  onClick={() => onSelectSession(session)}
                  title={sessionSourceTitle(session)}
                >
                  <span className="session-title-row">
                    <span className="session-title">{sessionDisplayTitle(session)}</span>
                    <span className="session-time" title={sessionActivityTitle(session)}>
                      {sessionActivityLabel(session)}
                    </span>
                  </span>
                  <span className="session-meta">
                    {sourceProviderLabel(session)} · {hostLabel(session.hostname, session.agentId, duplicateHostnames)} ·{" "}
                    {session.eventCount.toLocaleString()}
                  </span>
                  <span className="session-source">
                    {projectLabel(session)} · {sourceGenerationLabel(session) ? `${sourceGenerationLabel(session)} · ` : ""}
                    {session.sourcePath}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {hiddenSessionCount > 0 && (
            <div className="session-group">
              <div className="session-group-head">
                Showing {visibleSessionCount.toLocaleString()} of {filteredSessionCount.toLocaleString()}
              </div>
              <button className="icon-button compact-button" onClick={onLoadMore}>
                Load more
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
