export type TextPart = { kind: "text"; role: "user" | "assistant"; text: string; sourceEventId: string; partIndex: number };
export type ThinkPart = { kind: "thinking"; text: string; sourceEventId: string; partIndex: number };
export type ToolUseP = { kind: "tool_use"; name: string; input: any; id: string; sourceEventId: string; partIndex: number };
export type ToolResP = { kind: "tool_result"; content: any; isError?: boolean; id: string; sourceEventId: string; partIndex: number };
export type FlatPart = TextPart | ThinkPart | ToolUseP | ToolResP;
export type ToolGroup = { kind: "tool_group"; uses: ToolUseP[]; results: ToolResP[] };
export type RenderItem = TextPart | ThinkPart | ToolGroup;

export type VirtualRange = { start: number; end: number; top: number; bottom: number };
export type SavedScroll = { top: number; nearBottom: boolean };
export type ScrollAnchor = { key: string; offset: number };
export type UpdateRangeOptions = { captureAnchor?: boolean };
