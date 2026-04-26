# Dev Data Map And UI/Sync Findings

Snapshot date: 2026-04-26

This document summarizes the real dev/staging data behind `https://clo.vf.lc`. The SSH/deploy target is named `prod`, but for this project it is the development/staging VPS. In project conversation, "production" usually means this remote staging deploy unless explicitly stated otherwise. Raw exports and agent analysis files live under local `data/dev-prod-2026-04-26/`, which is intentionally ignored by git; the `dev-prod` name is historical and still refers to staging data.

No conversation content is reproduced here. The downloaded raw samples were treated as untrusted data, with long strings truncated before subagent analysis.

## Where The Data Lives

Remote staging/development server:

- Deploy directory: `/root/clo`
- App data directory: `/root/clo/data`
- Raw v2 chunks: `/root/clo/data/filesystem/sync/raw-chunks`
- Postgres data: `/root/clo/pgdata`
- Public URL: `https://clo.vf.lc` through Cloudflare

Local analysis copy:

- Raw chunk mirror: `data/dev-prod-2026-04-26/raw/raw-chunks`
- DB exports: `data/dev-prod-2026-04-26/db`
- Sanitized samples: `data/dev-prod-2026-04-26/samples`
- Subagent reports: `data/dev-prod-2026-04-26/agent-reports`

The local raw store had 3,814 raw chunk files at sample time. DB counts at export time had 3,785 raw chunk rows, so there is either live drift or a small orphan/missing-file gap worth verifying later.

## Current Storage Model

There are two read models:

- Legacy Claude model: `chat_sessions` and `session_events`
- Agent v2 model: `agents`, `agent_source_files`, `agent_raw_chunks`, `agent_normalized_events`, `agent_sync_cursors`

Current product behavior after the legacy quarantine change:

- Legacy tables stay in Postgres for reference and rollback.
- Default reads and sync ignore `chat_sessions`, `session_events`, and legacy `projects`.
- Only v2 session ids (`v2:*`) are loaded from browser cache and accepted into the current IndexedDB shell.
- Legacy readback can be temporarily re-enabled with `LEGACY_READ_ENABLED=true` if we need a debugging escape hatch.
- Legacy ingest remains separately gated by `LEGACY_INGEST_ENABLED`.

The active current path is v2:

1. The local agent scans provider JSONL roots.
2. It uploads source-file inventory and append chunks.
3. Backend stores raw chunk metadata in Postgres and raw chunk bodies in filesystem storage.
4. Backend normalizes each raw JSONL line into `agent_normalized_events`.
5. Read APIs map v2 data back into shared frontend `SessionInfo` and `SessionEvent` shapes.

Important tables from the snapshot:

| Table | Rows |
| --- | ---: |
| `agent_normalized_events` | 89,567 |
| `agent_raw_chunks` | 3,785 |
| `agent_source_files` | 724 |
| `agent_sync_cursors` | 725 |
| `agents` | 5 |
| `chat_sessions` | 263 |
| `session_events` | 110,216 |
| `projects` | 89 |
| `app_logs` | 18,821 |
| `yjs_documents` | 75 |

Provider snapshot from sanitized exports:

| Provider | Source files | Active files | Approx bytes | Last seen |
| --- | ---: | ---: | ---: | --- |
| Claude | 552 | 138 | 392 MB | 2026-04-26T12:47:56Z |
| Codex | 172 | 172 | 146 MB | 2026-04-26T12:48:11Z |

A later live query already showed Codex at 176 active files. The dataset is moving while the UI is open, so the protocol should assume metadata and events change continuously.

## Agents And Duplicate Devices

The dev DB has 5 agent rows across 3 hostnames. The important observed shape:

- One current v2 agent has all active v2 files.
- Several older agents share the same hostname but have zero source files.
- Older agents also carry a legacy `source_root`.

UI implication: group devices by normalized hostname for browsing, but show agent multiplicity when more than one agent exists for a hostname. Hide or de-emphasize zero-file stale agents by default. The route/session identity must stay based on session/source ids, not hostname.

Backend implication: `listV2Hosts` already filters to agents with active conversation files, which is good. Any future device settings or debug screen should distinguish active collectors from stale agent rows.

## Source File Metadata

`agent_source_files` is the right base for the sidebar and session list.

Useful fields:

- Identity: `id`, `agent_id`, `provider`, `source_kind`, `source_path`, `path_sha256`, `current_generation`
- Activity: `size_bytes`, `mtime_ms`, `first_seen_at`, `last_seen_at`, `deleted_at`
- Integrity: `content_sha256`, `mime_type`, `encoding`, `line_count`
- Provider metadata: `metadata`, `git`, `redaction`
- Raw storage summary: `raw_storage_key`, `raw_storage_bytes`

Observed quality:

- Claude source metadata has `projectKey`, `projectName`, and `sessionId` for all rows in the sample.
- Codex source metadata always has `sessionId`, but explicit `projectKey`, `projectName`, and `title` were sparse at sample time.
- Live backend derivation can recover Codex `cwd` for all active Codex files and a usable title for nearly all active Codex files by reading early normalized events.
- `deleted_at` is the only observed archive/deletion-like state. No separate provider-level "archived" field was found.

Recommended derived summary fields:

- `projectKey`, `projectName`, `cwd`
- `title`, `titleSource`
- `sessionId`, `providerSessionId`
- `lastEventAt`, `lastDisplayEventAt`, `firstEventAt`
- `eventCount`, `displayEventCount`, `messageCount`, `toolCallCount`, `toolResultCount`, `hiddenEventCount`
- `isSubagent`, `parentSessionId`, `subagentId`, `agentNickname`, `agentRole`, `parentThreadId`
- `sourceGeneration`, `sourceLineMin`, `sourceLineMax`, `sourceOffsetMin`, `sourceOffsetMax`

These should be materialized into a summary table or columns. The current v2 list path derives `cwd`, `sessionId`, and `title` with lateral JSONB subqueries over `agent_normalized_events`, which will get expensive as the corpus grows.

## Claude Code Raw Structure

Claude JSONL records are provider-native conversation events. Common fields:

- `type`
- `uuid`
- `parentUuid`
- `isSidechain`
- `timestamp`
- `sessionId`
- `cwd`
- `version`
- `gitBranch`
- `userType`
- `entrypoint`

Observed raw event types:

- `assistant`
- `user`
- `queue-operation`
- `system`
- `attachment`
- `last-prompt`

Assistant messages:

- `message.role` is `assistant`.
- `message.content` is an array.
- Content blocks include `text`, `thinking`, and `tool_use`.
- Tool calls carry ids such as `toolu_*`, a tool `name`, and open-ended `input`.
- `requestId` and `message.id` can group split assistant records from the same response.

User messages:

- `message.content` can be a plain string or an array of `tool_result` blocks.
- Tool results pair with assistant calls through `tool_use_id`.
- `sourceToolAssistantUUID` links a tool result back to the assistant event that requested it.
- `toolUseResult` can contain structured Bash/Read/Grep/Edit/Agent result data.

Subagents:

- Claude subagent files appear under path segments like `/subagents/`.
- In the source-file sample, 81 of 120 Claude rows were subagent files.
- Parent session can be derived from the path segment before `/subagents/`.
- `Agent` tool calls/results are the transcript-level launch/status hints.

UI recommendations for Claude:

- Render default transcript from normalized `display=true` events.
- Coalesce adjacent split assistant records when they share `requestId` or `message.id`.
- Pair tools by `toolu_*` id first, with UUID graph fields as fallback.
- Group subagent transcripts under their parent conversation in the sidebar.
- Keep `queue-operation`, `attachment`, `stop_hook_summary`, and `last-prompt` hidden from the main chat, but available in an event/debug view.

## Codex Raw Structure

Codex JSONL is mostly wrapped records with `type`, `timestamp`, and `payload`.

Observed top-level and provenance types:

- `response_item`
- `event_msg`
- `session_meta`
- `turn_context`
- `compacted`

Important `response_item.payload.type` variants:

- `message`
- `reasoning`
- `function_call`
- `function_call_output`

Important `event_msg.payload.type` variants:

- `agent_message`
- `user_message`
- `exec_command_begin`
- `exec_command_end`
- `token_count`
- `task_complete`
- `error`

Session and project metadata:

- `session_meta.payload.id` is the Codex session id.
- `session_meta.payload.cwd` is the best project signal.
- `session_meta.payload.git` can contain branch/commit/repository data.
- `session_meta` can also expose subagent metadata: `agent_role`, `agent_nickname`, and `source.subagent.thread_spawn.parent_thread_id`.

Tool pairing:

- `function_call.payload.call_id` starts a tool call.
- `function_call_output.payload.call_id` is a provisional/result event.
- `exec_command_end.payload.call_id` is the terminal process event with status, exit code, output, and duration.
- A single call id may have multiple result records. The UI should render one tool card with multiple result events, not duplicate cards.

Codex parser risks:

- Visible user/assistant text can appear both as `event_msg.*_message` and `response_item.message`; naive rendering can duplicate messages.
- Codex has many hidden/system events. Default UI must key off `normalized.display`, not `role` alone.
- `turn_context`, `session_meta`, compaction history, and encrypted reasoning can contain large or instruction-like text. Keep them collapsed/debug-only.
- `createdAt`, `receivedAt`, `lastSeenAt`, `mtimeMs`, raw `timestamp`, and filename dates all mean different things.

UI recommendations for Codex:

- Use title priority: explicit thread/title metadata, first visible user message, first visible assistant message, project plus date, source-path date fallback.
- Use `cwd` from `session_meta` for project grouping whenever source-file metadata lacks project fields.
- Show subagent nickname/role when available.
- Keep token counts, turn context, session meta, compaction, and hidden reasoning out of the main chat by default.

## Normalized Event Shape

`agent_normalized_events` is the best render surface.

Stable row fields:

- `id`
- `event_uid`
- `source_file_id`
- `agent_id`
- `provider`
- `source_generation`
- `source_line_no`
- `source_offset`
- `event_type`
- `role`
- `occurred_at`
- `created_at`
- `raw_chunk_id`
- `content_sha256`
- `normalized`

Normalized payload:

- `kind`
- `role`
- `display`
- `timestamp`
- `source.provider`
- `source.sourcePath`
- `source.rawType`
- `source.rawKind`
- `source.lineNo`
- `source.byteOffset`
- `parts`

Observed part variants:

- `{ kind: "text", text }`
- `{ kind: "thinking", text }`
- `{ kind: "tool_call", id, name, input }`
- `{ kind: "tool_result", id, content, isError }`
- `{ kind: "event", name, data }`

Provider event counts from the sample:

| Provider | Event type | Role | Count |
| --- | --- | --- | ---: |
| Claude | `tool_call` | assistant | 14,850 |
| Claude | `tool_result` | user | 14,685 |
| Claude | `message` | assistant | 8,686 |
| Claude | `event` | system | 7,495 |
| Claude | `message` | user | 1,647 |
| Claude | `thinking` | assistant | 722 |
| Codex | `event` | system | 30,454 |
| Codex | `tool_result` | tool | 4,905 |
| Codex | `tool_call` | tool | 3,159 |
| Codex | `thinking` | assistant | 1,381 |
| Codex | `message` | assistant | 988 |
| Codex | `turn` | system | 428 |
| Codex | `message` | user | 181 |
| Codex | `meta` | system | 172 |
| Codex | `session` | system | 6 |

Implication: system/debug/tool events dominate. The browser should not eagerly render or cache all event rows as the default path.

## Sidebar And Search Recommendations

The current tree direction is right: device -> provider -> project -> session. Improvements suggested by real data:

1. Device rows should display duplicate-agent state, for example "3 agents", with short ids in tooltip/detail.
2. Provider rows should stay explicit. Claude and Codex have different path and metadata semantics.
3. Project grouping should prefer real `projectName`, then Codex `cwd`, then a clear fallback such as "Unprojected Codex" or date buckets.
4. Claude subagents should be grouped under parent sessions and should not consume the same "show more sessions" budget as parent chats.
5. Archive/deleted dots should reflect retained tombstones. If deleted sessions are pruned from IndexedDB, the normal sidebar should not imply browsable archives.
6. Session rows should show only chat title plus compact date/status markers. Keep ids and source paths in tooltips/debug.
7. Add facets/chips for provider, device/agent, project, active/deleted, parent/subagent, date range, and large transcript size.
8. Keep title/search previews inert text, not Markdown.

## Markdown Rendering Safety

The main chat should render Markdown for user and assistant text, but with a narrow safe profile:

- Treat all transcript text as untrusted.
- Disable raw HTML or sanitize it.
- Do not execute, auto-run, or privileged-link tool commands from transcript content.
- Tool stdout/stderr should render as escaped text or fenced/preformatted blocks, not trusted Markdown by default.
- List titles and search result snippets should not render Markdown; use plain text with truncation.
- System/meta/debug payloads should stay collapsed and escaped.

This gives readable chat Markdown without turning stored conversation data into an instruction surface.

## Sync Protocol Findings

The current recent-first sync is directionally right:

- Metadata can sync separately from events.
- Event sync supports `forward`, `recent`, and `backfill`.
- Recent mode sets a high-water cursor so new events can keep flowing while older history backfills.

The next step is to make backfill less global.

Recommended protocol split:

- Metadata delta: host/session summary changes and tombstones.
- Active session pages: precise event windows for the open chat.
- Forward live sync: new events since high-water.
- Warm cache: newest displayable pages for active/visible sessions.
- Offline backfill: explicit, budgeted, idle-time history caching.

Do not automatically march toward caching all 200k current event rows in every browser. Warm newest useful pages first, then backfill old history only for active/visible/offline-prep priorities.

Per-session event pagination is needed:

```http
GET /api/v2/sessions/:id/events?anchor=end&limit=300&include=display
GET /api/v2/sessions/:id/events?before=<cursor>&limit=300&include=all
GET /api/v2/sessions/:id/events?after=<cursor>&limit=300&include=all
```

Suggested page info:

```json
{
  "pageInfo": {
    "startCursor": "...",
    "endCursor": "...",
    "hasOlder": true,
    "hasNewer": false,
    "totalEvents": 1234,
    "generation": 1
  }
}
```

Cursor key should use source-local ordering:

- v2: `(source_generation, source_line_no, source_offset, id)`
- legacy: `(source_line_no, source_offset, id)`
- global ids remain useful only for global forward sync.

## IndexedDB And Rendering Risks

Observed/frontend risks:

- Active-session loads should not clear the rendered chat before cached or remote replacement data arrives.
- Metadata sync should not delete active-session events except for explicit tombstones.
- `cacheSessionPayload` currently rewrites all cached events for a session; page writes would reduce flicker and memory churn.
- Global `getAll()` refreshes for all sessions/hosts after each sync are fine now, but will become noisy with larger datasets.
- The global event cache needs page coverage metadata and a retention policy.

Recommended browser cache metadata per session:

- `newestLoadedCursor`
- `oldestLoadedCursor`
- `hasOlder`
- `hasNewer`
- `generation`
- `loadedDisplayOnly`
- `updatedAt`
- `byteEstimate`

## Indexing Recommendations

Add or verify indexes for the current and proposed queries:

- `agent_source_files (last_seen_at desc, id desc) where source_kind = 'conversation' and deleted_at is null`
- `agent_source_files (agent_id, last_seen_at desc, id desc) where source_kind = 'conversation' and deleted_at is null`
- Explicit `updated_at` on source/session summary tables, or an indexable replacement for `greatest(last_seen_at, coalesce(deleted_at, last_seen_at))`
- `agent_normalized_events (source_file_id, source_generation, source_line_no, source_offset, id)`
- `agent_normalized_events (source_file_id, source_generation, id)`
- Optional materialized `displayable boolean` plus partial index for display-only pages

Avoid depending long-term on `row_number() over (partition by source_file_id ...)` in global sync. Store source-local ordinal at ingest or use line/offset directly on the client.

## Implementation Plan

P0:

1. Add a session summary projection and make v2 list endpoints read from it.
2. Add per-session paginated event APIs and page-aware IndexedDB writes.
3. Stop automatic full-history backfill by default; warm active and visible sessions first.
4. Improve safe Markdown rendering for transcript text while keeping tools/debug escaped.

P1:

1. Add the event/source indexes above.
2. Store or expose source-local event ordering without global window functions.
3. Group Claude subagents under parent sessions in the sidebar.
4. Show duplicate-agent state on device rows.
5. Replace all-cache React refreshes with payload-level state updates or targeted reads.

P2:

1. Add raw-store integrity verification and orphan cleanup.
2. Add cache budgets and LRU eviction for event pages.
3. Add an optional offline-prep mode with explicit storage budget and a service-worker reset/disable control before enabling any persistent worker behavior.
4. Add parser fixture tests for Claude subagents, Codex duplicate message echoes, tool pairing, queue operations, attachments, compaction, and hidden reasoning.

## Bottom Line

The ingest side is already close to the right shape: generation-aware source files, append cursors, raw chunk storage, normalized events, and recent/backfill sync. The next durable improvement is a summary projection plus per-session event pagination. That will make the tree fast, make live sync less flickery, and let the browser cache only the data the user is actually looking at.
