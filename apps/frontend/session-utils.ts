import type { SessionInfo } from "../../packages/shared/types";

export function shortId(value: string, size = 8) {
  return value.length <= size ? value : value.slice(0, size);
}

export function providerFilterValue(session: SessionInfo) {
  return session.sourceProvider || (session.id.startsWith("v2:") ? "v2" : "legacy");
}

export function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "gemini") return "Gemini";
  if (provider === "legacy") return "Legacy";
  if (provider === "v2") return "V2";
  if (provider === "unknown") return "Unknown";
  return provider.slice(0, 1).toUpperCase() + provider.slice(1);
}

export function sourceProviderLabel(session: SessionInfo) {
  return providerLabel(providerFilterValue(session));
}

export function sourceGenerationLabel(session: SessionInfo) {
  return session.sourceGeneration ? `g${session.sourceGeneration}` : null;
}

export function hostLabel(hostname: string, agentId: string, duplicateHostnames: Set<string>) {
  return duplicateHostnames.has(hostname) ? `${hostname} · ${shortId(agentId)}` : hostname;
}

export function sessionSourceTitle(session: SessionInfo) {
  return [
    `Provider: ${sourceProviderLabel(session)}`,
    `Host: ${session.hostname}`,
    `Agent: ${session.agentId}`,
    session.sourceGeneration ? `Generation: ${session.sourceGeneration}` : null,
    `Source: ${session.sourcePath}`,
    session.gitBranch ? `Git: ${session.gitBranch}${session.gitCommit ? ` @ ${shortId(session.gitCommit, 10)}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
