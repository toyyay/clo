import type { SessionInfo } from "../../packages/shared/types";
import { VirtualChat, type RenderItem } from "./chat-transcript";
import { hostLabel, sessionDisplayTitle, sessionSourceTitle, sourceGenerationLabel, sourceProviderLabel } from "./session-utils";

type MainChatProps = {
  active: SessionInfo | null;
  eventsLength: number;
  items: RenderItem[];
  draft: string;
  duplicateHostnames: Set<string>;
  onDraftChange: (value: string) => void;
};

export function MainChat({ active, eventsLength, items, draft, duplicateHostnames, onDraftChange }: MainChatProps) {
  return (
    <main className="main">
      {!active && <div className="empty">No cached chats yet</div>}
      {active && (
        <div className="chat">
          <div className="chat-head">
            <div>
              <div className="chat-title">{sessionDisplayTitle(active)}</div>
              <div className="chat-subtitle">
                {sourceProviderLabel(active)} / {active.projectName} /{" "}
                {hostLabel(active.hostname, active.agentId, duplicateHostnames)}
              </div>
              <div className="chat-source" title={sessionSourceTitle(active)}>
                <span className="source-pill">{active.id.startsWith("v2:") ? "v2" : "legacy"}</span>
                {sourceGenerationLabel(active) && <span className="source-pill">{sourceGenerationLabel(active)}</span>}
                <span className="chat-source-path">{active.sourcePath}</span>
              </div>
            </div>
            <div className="chat-count">{eventsLength}</div>
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
