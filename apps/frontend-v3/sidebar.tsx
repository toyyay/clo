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

const PAGE_SIZE = 20;

type ExpandedState = Set<string>;

export function Sidebar() {
  const store = useStore();
  const state = useStoreState();
  const [expanded, setExpanded] = useState<ExpandedState>(() => readExpanded());
  const [hostNodes, setHostNodes] = useState<GroupNode[]>([]);
  const [childrenByParent, setChildrenByParent] = useState<Map<string, GroupNode[]>>(new Map());
  const [chatPagesByGroup, setChatPagesByGroup] = useState<Map<string, ChatIndex[]>>(new Map());
  const [chatHasMoreByGroup, setChatHasMoreByGroup] = useState<Map<string, boolean>>(new Map());

  // Boot: load level=1 hosts.
  useEffect(() => {
    void idb.getGroupsByLevel(1).then((rows) => setHostNodes(sortByLastSeen(rows)));
  }, [state.groups.size]); // re-run when store gets fresh groups (trivial dep, fine for boot)

  const expand = useCallback(async (key: string) => {
    const next = new Set(expanded);
    next.add(key);
    setExpanded(next);
    persistExpanded(next);

    // Fetch direct children if not cached.
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

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span>Chats</span>
        <ConnectionDot status={state.status.kind} />
      </header>
      <div className="tree">
        {hostNodes.map((host) => (
          <HostNode
            key={host.key}
            node={host}
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
    </aside>
  );
}

type NodeProps = {
  node: GroupNode;
  expanded: ExpandedState;
  childrenByParent: Map<string, GroupNode[]>;
  chatPagesByGroup: Map<string, ChatIndex[]>;
  chatHasMoreByGroup: Map<string, boolean>;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
  onLoadChats: (projectKey: string, append?: boolean) => void;
};

function HostNode(props: NodeProps) {
  return <GroupRow {...props} indent={0} />;
}

function GroupRow(props: NodeProps & { indent: number }) {
  const { node, expanded, childrenByParent, indent } = props;
  const isOpen = expanded.has(node.key);
  return (
    <div className={`group-row group-l${node.level}`}>
      <button
        className="group-toggle"
        onClick={() => (isOpen ? props.onCollapse(node.key) : props.onExpand(node.key))}
        style={{ paddingLeft: indent * 12 }}
      >
        <span className={`caret ${isOpen ? "open" : ""}`}>▶</span>
        <span className="group-label">{node.label}</span>
        <span className="group-meta">{node.chatCount} · {formatBytes(node.approxBytes)}</span>
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
  const store = useStore();
  const state = useStoreState();
  const { project, chatPagesByGroup, chatHasMoreByGroup, onLoadChats, indent } = props;
  const cached = chatPagesByGroup.get(project.key);
  const previewIds = project.topChatIds;

  // Load preview from chat_index by ids (5 chats max — cheap)
  const [preview, setPreview] = useState<ChatIndex[]>([]);
  useEffect(() => {
    void idb.getChatIndexMany(previewIds).then((rows) => setPreview(sortChatsByLastSeen(rows)));
  }, [previewIds.join("|")]);

  const list = cached ?? preview;
  const hasMore = chatHasMoreByGroup.get(project.key) ?? (cached === undefined && project.chatCount > preview.length);

  return (
    <div className="project-chats">
      {list.map((chat) => (
        <button
          key={chat.chatId}
          className={`chat-row ${state.activeChat === chat.chatId ? "active" : ""}`}
          onClick={() => store.openChat(chat.chatId)}
          style={{ paddingLeft: indent * 12 }}
          title={chat.title}
        >
          <span className="chat-title">{chat.title}</span>
          <span className="chat-meta">{formatBytes(chat.approxBytes)}</span>
        </button>
      ))}
      {hasMore && (
        <button className="show-more" onClick={() => onLoadChats(project.key, !!cached)} style={{ paddingLeft: indent * 12 }}>
          {cached ? "Show more" : `Show all ${project.chatCount}`}
        </button>
      )}
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  return (
    <span className={`conn-dot conn-${status}`} title={status}>●</span>
  );
}

function sortByLastSeen<T extends { lastSeenAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function sortChatsByLastSeen(rows: ChatIndex[]): ChatIndex[] {
  return [...rows].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function formatBytes(b: number): string {
  if (!b) return "0";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
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
