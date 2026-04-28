import type { SessionInfo } from "../../packages/shared/types";
import type { SyncHealth, SyncState } from "./app-types";
import { VirtualChat, type RenderItem } from "./chat-transcript";
import {
  sessionActivityLabel,
  sessionActivityDateLabel,
  sessionActivityTitle,
  sessionArchiveLabel,
  sessionDisplayTitle,
  sessionSourceTitle,
} from "./session-utils";

type MainChatProps = {
  active: SessionInfo | null;
  eventsLength: number;
  eventWindowed?: boolean;
  hasOlderEvents?: boolean;
  hasNewerEvents?: boolean;
  items: RenderItem[];
  draft: string;
  now: number;
  syncHealth: SyncHealth;
  syncState: SyncState;
  onDraftChange: (value: string) => void;
  onLoadOlderEvents?: () => void;
  onLoadNewerEvents?: () => void;
};

export function MainChat({
  active,
  eventsLength,
  eventWindowed,
  hasOlderEvents,
  hasNewerEvents,
  items,
  draft,
  now,
  syncHealth,
  syncState,
  onDraftChange,
  onLoadOlderEvents,
  onLoadNewerEvents,
}: MainChatProps) {
  const chatStatus = active ? chatLoadStatus(active, eventsLength, syncState, syncHealth.online, Boolean(eventWindowed)) : null;
  const relativeActivity = active ? sessionActivityLabel(active, now) : "";

  return (
    <main className="main">
      {!active && <div className="empty">No cached chats yet</div>}
      {active && (
        <div className="chat">
          <div className="chat-head" title={sessionSourceTitle(active)}>
            <div className="chat-heading">
              <div className="chat-title">{sessionDisplayTitle(active)}</div>
              <div className="chat-date" title={sessionActivityTitle(active)}>
                {sessionActivityDateLabel(active)}
                {relativeActivity ? ` · ${relativeActivity}` : ""}
              </div>
            </div>
            <div className={`chat-status ${chatStatus?.kind ?? "loaded"}`} title={chatStatus?.title ?? sessionArchiveLabel(active)}>
              <span className={`archive-dot ${active.deletedAt ? "archived" : "active"}`} />
              {chatStatus && <span>{chatStatus.label}</span>}
            </div>
          </div>

          <VirtualChat
            items={items}
            resetKey={active.id}
            hasOlder={Boolean(hasOlderEvents)}
            hasNewer={Boolean(hasNewerEvents)}
            onLoadOlder={onLoadOlderEvents}
            onLoadNewer={onLoadNewerEvents}
          />

          <div className="composer">
            <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="Reply..." rows={2} />
            <button className="send-button" disabled title="UI only for now">
              Send
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function chatLoadStatus(active: SessionInfo, eventsLength: number, syncState: SyncState, online: boolean, windowed: boolean) {
  const expected = Math.max(0, active.eventCount ?? 0);
  const loaded = Math.max(0, eventsLength);
  const verb = windowed ? "showing" : "cached";
  const count = expected > 0 ? `${loaded.toLocaleString()}/${expected.toLocaleString()} events` : `${loaded.toLocaleString()} events`;
  const cacheTitle = `${sessionArchiveLabel(active)} / cached ${count}`;

  if (!online || syncState === "offline") {
    return {
      kind: "offline",
      label: loaded ? `Offline · ${verb} ${count}` : "Offline · no cached events",
      title: `${cacheTitle}\nBackend is not reachable; showing local cache only.`,
    };
  }
  if (syncState === "error") {
    return {
      kind: "error",
      label: loaded ? `Backend issue · ${verb} ${count}` : "Backend issue · no cached events",
      title: `${cacheTitle}\nThe last sync failed; showing local cache while retrying.`,
    };
  }
  if (syncState === "syncing") {
    return {
      kind: "syncing",
      label: expected > loaded ? `Syncing · ${count}` : "Syncing",
      title: `${cacheTitle}\nSync is running.`,
    };
  }
  if (expected > loaded) {
    return {
      kind: "pending",
      label: windowed ? `Showing ${count}` : `Loaded ${count} · history pending`,
      title: windowed ? `${cacheTitle}\nHistory loads while scrolling.` : `${cacheTitle}\nMore events are expected for this chat.`,
    };
  }
  if (expected === 0 && loaded === 0) {
    return {
      kind: "loaded",
      label: "No events yet",
      title: `${sessionArchiveLabel(active)} / no events`,
    };
  }
  return {
    kind: "loaded",
    label: windowed ? `Showing ${count}` : `Loaded ${loaded.toLocaleString()} events`,
    title: windowed ? `${cacheTitle}\nOlder history loads while scrolling.` : `${sessionArchiveLabel(active)} / loaded ${loaded.toLocaleString()} events`,
  };
}
