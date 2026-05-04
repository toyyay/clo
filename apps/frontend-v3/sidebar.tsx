// Lazy paged sidebar tree.
//
// Принципы:
//   • Никогда не загружаем полный список чатов в память.
//   • Раскрытие узла → IDB cursor по index byParentLastSeen, limit маленький.
//   • Для project-узла показываем topChatIds (5 штук). Show more → page size 20.
//   • Реактивная подписка на store.groups, чтобы дельты от сервера обновляли узлы.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatIndex, GroupNode } from "../../packages/sync-v3/contracts";
import * as idb from "./idb";
import { useStoreState, useStore } from "./store-hook";
import { formatBytes, formatRelative } from "./format";

const PAGE_SIZE = 20;

type ExpandedState = Set<string>;

export function Sidebar({ visible }: { visible: boolean }) {
  const store = useStore();
  const state = useStoreState();
  const [expanded, setExpanded] = useState<ExpandedState>(() => readExpanded());
  const [hostNodes, setHostNodes] = useState<GroupNode[]>([]);
  const [childrenByParent, setChildrenByParent] = useState<Map<string, GroupNode[]>>(new Map());
  const [chatPagesByGroup, setChatPagesByGroup] = useState<Map<string, ChatIndex[]>>(new Map());
  const [chatHasMoreByGroup, setChatHasMoreByGroup] = useState<Map<string, boolean>>(new Map());
  const [search, setSearch] = useState("");

  // Boot: load level=1 hosts. Re-run when store gets fresh groups.
  useEffect(() => {
    void idb.getGroupsByLevel(1).then((rows) => setHostNodes(sortByLastSeen(rows)));
  }, [state.groups.size]);

  const expand = useCallback(async (key: string) => {
    const next = new Set(expanded);
    next.add(key);
    setExpanded(next);
    persistExpanded(next);

    if (!childrenByParent.has(key)) {
      const kids = await store.loadGroupChildren(key);
      const updated = new Map(childrenByParent);
      updated.set(key, sortByLastSeen(kids));
      setChildrenByParent(updated);
    }
  }, [childrenByParent, expanded, store]);

  const collapse = useCallback((key: string) => {
    const next = new Set(expanded);
    next.delete(key);
    setExpanded(next);
    persistExpanded(next);
  }, [expanded]);

  const loadChatsForProject = useCallback(async (projectKey: string, append = false) => {
    const after = append ? chatPagesByGroup.get(projectKey)?.at(-1)?.lastSeenAt : undefined;
    const next = await store.loadChatPage(projectKey, { afterLastSeenAt: after, limit: PAGE_SIZE });
    const updatedPages = new Map(chatPagesByGroup);
    const existing = updatedPages.get(projectKey) ?? [];
    const merged = append ? [...existing, ...next] : next;
    updatedPages.set(projectKey, merged);
    setChatPagesByGroup(updatedPages);
    const updatedHasMore = new Map(chatHasMoreByGroup);
    updatedHasMore.set(projectKey, next.length === PAGE_SIZE);
    setChatHasMoreByGroup(updatedHasMore);
  }, [chatPagesByGroup, chatHasMoreByGroup, store]);

  const searchResults = useSearch(search, state.visibleChats);

  return (
    <aside className={`sidebar ${visible ? "visible" : "hidden"}`}>
      <div className="sidebar-search">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
      </div>

      {search.trim() ? (
        <div className="tree">
          {searchResults.length === 0 ? (
            <div className="empty-tree">No matches</div>
          ) : (
            searchResults.map((chat) => (
              <ChatRow key={chat.chatId} chat={chat} indent={0} />
            ))
          )}
        </div>
      ) : (
        <div className="tree">
          {hostNodes.map((host) => (
            <GroupRow
              key={host.key}
              node={host}
              indent={0}
              expanded={expanded}
              childrenByParent={childrenByParent}
              chatPagesByGroup={chatPagesByGroup}
              chatHasMoreByGroup={chatHasMoreByGroup}
              onExpand={expand}
              onCollapse={collapse}
              onLoadChats={loadChatsForProject}
            />
          ))}
          {!hostNodes.length && <div className="empty-tree">No data yet — connecting…</div>}
        </div>
      )}
    </aside>
  );
}

function useSearch(query: string, visibleChats: Map<string, ChatIndex>): ChatIndex[] {
  const trimmed = query.trim().toLowerCase();
  return useMemo(() => {
    if (!trimmed) return [];
    const out: ChatIndex[] = [];
    for (const c of visibleChats.values()) {
      if (c.title.toLowerCase().includes(trimmed) || c.chatId.toLowerCase().includes(trimmed)) {
        out.push(c);
      }
      if (out.length >= 50) break;
    }
    out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return out;
  }, [trimmed, visibleChats]);
}

type NodeProps = {
  node: GroupNode;
  indent: number;
  expanded: ExpandedState;
  childrenByParent: Map<string, GroupNode[]>;
  chatPagesByGroup: Map<string, ChatIndex[]>;
  chatHasMoreByGroup: Map<string, boolean>;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
  onLoadChats: (projectKey: string, append?: boolean) => void;
};

function GroupRow(props: NodeProps) {
  const { node, expanded, childrenByParent, indent } = props;
  const isOpen = expanded.has(node.key);
  return (
    <div className={`group-row group-l${node.level}`}>
      <button
        className="group-toggle"
        onClick={() => (isOpen ? props.onCollapse(node.key) : props.onExpand(node.key))}
        style={{ paddingLeft: 8 + indent * 12 }}
      >
        <span className={`caret ${isOpen ? "open" : ""}`}>▶</span>
        <span className="group-label">{node.label}</span>
        <span className="group-meta">
          <span className="group-count">{node.chatCount}</span>
          <span className="group-bytes">{formatBytes(node.approxBytes)}</span>
          {node.lastSeenAt && <span className="group-time">{formatRelative(node.lastSeenAt)}</span>}
        </span>
      </button>
      {isOpen && (
        <div className="group-children">
          {(childrenByParent.get(node.key) ?? []).map((child) => (
            <GroupRow key={child.key} {...props} node={child} indent={indent + 1} />
          ))}
          {node.level === 3 && <ProjectChats {...props} project={node} indent={indent + 1} />}
        </div>
      )}
    </div>
  );
}

function ProjectChats(props: NodeProps & { project: GroupNode; indent: number }) {
  const { project, chatPagesByGroup, chatHasMoreByGroup, onLoadChats, indent } = props;
  const cached = chatPagesByGroup.get(project.key);
  const previewIds = project.topChatIds;

  const [preview, setPreview] = useState<ChatIndex[]>([]);
  useEffect(() => {
    void idb.getChatIndexMany(previewIds).then((rows) => setPreview(sortChatsByLastSeen(rows)));
  }, [previewIds.join("|")]);

  const list = cached ?? preview;
  const hasMore = chatHasMoreByGroup.get(project.key) ?? (cached === undefined && project.chatCount > preview.length);

  return (
    <div className="project-chats">
      {list.map((chat) => (
        <ChatRow key={chat.chatId} chat={chat} indent={indent} />
      ))}
      {hasMore && (
        <button
          className="show-more"
          onClick={() => onLoadChats(project.key, !!cached)}
          style={{ paddingLeft: 8 + indent * 12 }}
        >
          {cached ? "Show more" : `Show all ${project.chatCount}`}
        </button>
      )}
    </div>
  );
}

function ChatRow({ chat, indent }: { chat: ChatIndex; indent: number }) {
  const store = useStore();
  const state = useStoreState();
  const active = state.activeChat === chat.chatId;
  return (
    <button
      className={`chat-row ${active ? "active" : ""}`}
      onClick={() => store.openChat(chat.chatId)}
      style={{ paddingLeft: 8 + indent * 12 }}
      title={`${chat.title}\n${chat.itemCount.toLocaleString()} items · ${formatBytes(chat.approxBytes)}\nlast seen ${chat.lastSeenAt}`}
    >
      <span className="chat-title">{chat.title || chat.chatId}</span>
      <span className="chat-meta">
        <span className="chat-bytes">{formatBytes(chat.approxBytes)}</span>
        <span className="chat-time">{formatRelative(chat.lastSeenAt)}</span>
      </span>
    </button>
  );
}

function sortByLastSeen<T extends { lastSeenAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function sortChatsByLastSeen(rows: ChatIndex[]): ChatIndex[] {
  return [...rows].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

const EXPANDED_KEY = "chatview-v3:sidebar-expanded";

function readExpanded(): ExpandedState {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function persistExpanded(set: ExpandedState) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  } catch {}
}
