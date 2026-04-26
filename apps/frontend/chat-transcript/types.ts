export type TextPart = { kind: "text"; role: "user" | "assistant"; text: string };
export type ThinkPart = { kind: "thinking"; text: string };
export type ToolUseP = { kind: "tool_use"; name: string; input: any; id: string };
export type ToolResP = { kind: "tool_result"; content: any; isError?: boolean; id: string };
export type FlatPart = TextPart | ThinkPart | ToolUseP | ToolResP;
export type ToolGroup = { kind: "tool_group"; uses: ToolUseP[]; results: ToolResP[] };
export type RenderItem = TextPart | ThinkPart | ToolGroup;

export type VirtualRange = { start: number; end: number; top: number; bottom: number };
export type SavedScroll = { top: number; nearBottom: boolean };
export type ScrollAnchor = { index: number; offset: number };
export type UpdateRangeOptions = { captureAnchor?: boolean };
