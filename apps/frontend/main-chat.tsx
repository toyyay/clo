import type { SessionInfo } from "../../packages/shared/types";
import { VirtualChat, type RenderItem } from "./chat-transcript";
import {
  sessionActivityDateLabel,
  sessionActivityTitle,
  sessionArchiveLabel,
  sessionDisplayTitle,
  sessionSourceTitle,
} from "./session-utils";

type MainChatProps = {
  active: SessionInfo | null;
  eventsLength: number;
  items: RenderItem[];
  draft: string;
  onDraftChange: (value: string) => void;
};

export function MainChat({ active, eventsLength, items, draft, onDraftChange }: MainChatProps) {
  return (
    <main className="main">
      {!active && <div className="empty">No cached chats yet</div>}
      {active && (
        <div className="chat">
          <div className="chat-head" title={sessionSourceTitle(active)}>
            <div className="chat-heading">
              <div className="chat-title">{sessionDisplayTitle(active)}</div>
              <div className="chat-date" title={sessionActivityTitle(active)}>{sessionActivityDateLabel(active)}</div>
            </div>
            <div className="chat-status" title={`${sessionArchiveLabel(active)} / ${eventsLength.toLocaleString()} events`}>
              <span className={`archive-dot ${active.deletedAt ? "archived" : "active"}`} />
            </div>
          </div>

          <VirtualChat items={items} resetKey={active.id} />

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
