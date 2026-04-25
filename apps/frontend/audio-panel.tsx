import { useCallback, useRef, useState, type ReactElement } from "react";
import type { AppSettingsInfo, AudioTranscriptLevel, AudioTranscriptionInfo, ImportedAudioInfo } from "../../packages/shared/types";
import { OPENROUTER_REASONING_EFFORTS, OPENROUTER_TRANSCRIPTION_MODELS } from "../../packages/shared/types";
import type { CachedAudioRecording } from "./audio-cache";

export type TranscriptLanguage = "ru" | "en";
type TranscriptLevelKey = keyof AudioTranscriptLevel;
export type AudioRetryOptions = { model: string; reasoningEffort: string };
export type RecordingUiState = {
  active: boolean;
  elapsedMs: number;
  chunkCount: number;
  mimeType: string;
  error: string;
};

export const FALLBACK_TRANSCRIPTION_MODELS = [...OPENROUTER_TRANSCRIPTION_MODELS];
export const FALLBACK_REASONING_EFFORTS = [...OPENROUTER_REASONING_EFFORTS];

const TRANSCRIPT_LEVELS: { key: TranscriptLevelKey; label: string }[] = [
  { key: "literal", label: "Literal" },
  { key: "clean", label: "Clean" },
  { key: "summary", label: "Summary" },
  { key: "brief", label: "Brief" },
];

export function AudioModal({
  items,
  loading,
  error,
  language,
  busyMediaId,
  uploadStatus,
  recording,
  cachedRecordings,
  models,
  reasoningEfforts,
  onLanguage,
  onRefresh,
  onUploadFiles,
  onFlushCache,
  onToggleRecording,
  onRetry,
  onDelete,
  onInsert,
  onClose,
}: {
  items: ImportedAudioInfo[];
  loading: boolean;
  error: string;
  language: TranscriptLanguage;
  busyMediaId: string;
  uploadStatus: string;
  recording: RecordingUiState;
  cachedRecordings: CachedAudioRecording[];
  models: AppSettingsInfo["transcriptionModels"];
  reasoningEfforts: readonly string[];
  onLanguage: (language: TranscriptLanguage) => void;
  onRefresh: () => void;
  onUploadFiles: (files: File[]) => void;
  onFlushCache: () => void;
  onToggleRecording: () => void;
  onRetry: (mediaId: string, options: AudioRetryOptions) => void;
  onDelete: (mediaId: string) => void;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submitFiles = useCallback(
    (files: FileList | File[]) => {
      const audioFiles = Array.from(files).filter(isAudioLikeFile);
      if (audioFiles.length) onUploadFiles(audioFiles);
    },
    [onUploadFiles],
  );

  return (
    <ModalFrame title="Audio" onClose={onClose}>
      <div className="audio-toolbar">
        <div className="segmented">
          <button className={language === "ru" ? "active" : ""} onClick={() => onLanguage("ru")}>
            RU
          </button>
          <button className={language === "en" ? "active" : ""} onClick={() => onLanguage("en")}>
            EN
          </button>
        </div>
        <button className="icon-button compact-button" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="modal-body audio-list">
        {error && <div className="modal-error">{error}</div>}
        <section
          className="audio-upload-panel"
          tabIndex={0}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            submitFiles(event.dataTransfer.files);
          }}
          onPaste={(event) => submitFiles(event.clipboardData.files)}
        >
          <input
            ref={inputRef}
            className="hidden-file-input"
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.ogg,.opus,.webm,.mp4,.mov"
            multiple
            onChange={(event) => {
              if (event.currentTarget.files) submitFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <div className="audio-upload-main">
            <div>
              <div className="audio-title">Upload audio</div>
              <div className="audio-meta">{uploadStatus || "Drop, paste, or choose files"}</div>
            </div>
            <button className="icon-button compact-button" onClick={() => inputRef.current?.click()}>
              Choose
            </button>
          </div>
        </section>

        <section className="audio-record-panel">
          <div className="audio-upload-main">
            <div>
              <div className="audio-title">{recording.active ? "Recording" : "Browser recording"}</div>
              <div className="audio-meta">
                {recording.active
                  ? `${formatDurationMs(recording.elapsedMs)} / ${recording.chunkCount} chunks`
                  : cachedRecordings.length
                    ? `${cachedRecordings.length} cached`
                    : "Idle"}
              </div>
            </div>
            <button className={`icon-button compact-button ${recording.active ? "danger-button" : ""}`} onClick={onToggleRecording}>
              {recording.active ? "Stop" : "Record"}
            </button>
          </div>
          {recording.error && <div className="modal-error">{recording.error}</div>}
          {cachedRecordings.length > 0 && (
            <div className="audio-cache-list">
              {cachedRecordings.map((record) => (
                <div className={`audio-cache-row ${record.status}`} key={record.id}>
                  <span>
                    {record.status} / {formatDurationMs(record.durationMs)} / {record.chunkCount} chunks
                  </span>
                  {record.error ? <b>{record.error}</b> : <b>{record.filename}</b>}
                </div>
              ))}
              <button className="mini-action" onClick={onFlushCache}>
                Upload cached
              </button>
            </div>
          )}
        </section>

        {!items.length && !loading && <div className="empty-modal">No uploaded audio yet</div>}
        {items.map((item) => (
          <AudioItem
            key={item.id}
            item={item}
            language={language}
            busy={busyMediaId === item.id}
            models={models}
            reasoningEfforts={reasoningEfforts}
            onRetry={(options) => onRetry(item.id, options)}
            onDelete={() => onDelete(item.id)}
            onInsert={onInsert}
          />
        ))}
      </div>
    </ModalFrame>
  );
}

export function chooseRecorderMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

export function extensionForMime(mimeType: string) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

export function isAudioLikeFile(file: File) {
  return file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac|caf|ogg|opus|webm|mp4|mov)$/i.test(file.name);
}

function AudioItem({
  item,
  language,
  busy,
  models,
  reasoningEfforts,
  onRetry,
  onDelete,
  onInsert,
}: {
  item: ImportedAudioInfo;
  language: TranscriptLanguage;
  busy: boolean;
  models: AppSettingsInfo["transcriptionModels"];
  reasoningEfforts: readonly string[];
  onRetry: (options: AudioRetryOptions) => void;
  onDelete: () => void;
  onInsert: (text: string) => void;
}) {
  const transcription = displayTranscription(item);
  const latestAttempt = latestTranscription(item);
  const transcript = transcription?.transcript?.[language];
  const fallbackModel = transcription?.model || models[0]?.id || FALLBACK_TRANSCRIPTION_MODELS[0].id;
  const fallbackEffort = transcription?.reasoningEffort || reasoningEfforts[1] || "medium";
  const [model, setModel] = useState(fallbackModel);
  const [reasoningEffort, setReasoningEffort] = useState(fallbackEffort);
  const modelOptions = models.some((option) => option.id === model)
    ? models
    : [{ id: model, label: model, description: "Current" }, ...models];
  return (
    <article className="audio-item">
      <div className="audio-item-head">
        <div>
          <div className="audio-title">{item.filename || `audio-${item.id}`}</div>
          <div className="audio-meta">
            {formatBytes(item.sizeBytes)} / {item.detectedFormat ?? item.contentType ?? "audio"}{" "}
            {formatDuration(item.durationSeconds)}
          </div>
        </div>
        <div className="audio-actions">
          <button className="icon-button compact-button" onClick={() => onRetry({ model, reasoningEffort })} disabled={busy}>
            {busy ? "Queued" : "Retry"}
          </button>
          <button className="icon-button compact-button danger-button" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </div>
      <div className="audio-retry-controls">
        <label>
          <span>Model</span>
          <select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Effort</span>
          <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.currentTarget.value)}>
            {reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <audio controls preload="none" src={`/api/imports/media/file?id=${encodeURIComponent(item.id)}`} />
      {latestAttempt && latestAttempt.id !== transcription?.id && (
        <div className={`transcription-attempt ${latestAttempt.status}`}>
          Latest attempt: {latestAttempt.status} / {latestAttempt.model}
          {latestAttempt.error ? ` / ${latestAttempt.error}` : ""}
        </div>
      )}
      {transcription ? (
        <div className={`transcription ${transcription.status}`}>
          <div className="transcription-status">
            {transcription.status} / {transcription.model} / {transcription.reasoningEffort}
          </div>
          {transcription.error && <div className="modal-error">{transcription.error}</div>}
          {transcript &&
            TRANSCRIPT_LEVELS.map(({ key, label }) =>
              transcript[key] ? (
                <div className="transcript-block" key={key}>
                  <div className="transcript-row">
                    <div className="transcript-label">{label}</div>
                    <button className="mini-action" onClick={() => onInsert(transcript[key])}>
                      Insert
                    </button>
                  </div>
                  <p>{transcript[key]}</p>
                </div>
              ) : null,
            )}
        </div>
      ) : (
        <div className="muted-text">Transcription is queued after upload.</div>
      )}
    </article>
  );
}

function ModalFrame({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactElement | ReactElement[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button compact-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function latestTranscription(item: ImportedAudioInfo) {
  return item.transcriptions[0] ?? null;
}

function transcriptHasContent(transcription?: AudioTranscriptionInfo | null) {
  const transcript = transcription?.transcript;
  return Boolean(
    transcript?.ru.literal?.trim() ||
      transcript?.ru.clean?.trim() ||
      transcript?.ru.summary?.trim() ||
      transcript?.en.literal?.trim() ||
      transcript?.en.clean?.trim() ||
      transcript?.en.summary?.trim(),
  );
}

function displayTranscription(item: ImportedAudioInfo) {
  return (
    item.transcriptions.find((transcription) => transcription.status === "completed" && transcriptHasContent(transcription)) ??
    latestTranscription(item)
  );
}

function formatBytes(value?: number | null) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds?: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = String(rounded % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatDurationMs(ms?: number | null) {
  if (!ms || !Number.isFinite(ms)) return "0:00";
  return formatDuration(Math.max(0, ms / 1000)) || "0:00";
}
