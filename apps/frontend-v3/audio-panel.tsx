// Audio modal — upload, browser recording, transcription retry, insert into composer.
// Ported from apps/frontend with these adjustments:
//   • Self-contained: opens its own data hook (useAudioImports) instead of
//     receiving 15 props from the parent.
//   • The "insert into composer" callback isn't wired in v3 (composer is
//     read-only for now), so the Insert button is hidden.
//   • Authentication is implicit — page only renders if the WS gate let
//     us in, so `isAuthenticated` is always true in here.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  AppSettingsInfo,
  AudioTranscriptLevel,
  AudioTranscriptionInfo,
  ImportedAudioInfo,
} from "../../packages/shared/types";
import { OPENROUTER_REASONING_EFFORTS, OPENROUTER_TRANSCRIPTION_MODELS } from "../../packages/shared/types";
import {
  appendCachedAudioChunk,
  createCachedAudioRecording,
  deleteCachedAudioRecording,
  finalizeCachedAudioRecording,
  loadCachedAudioBlob,
  loadCachedAudioRecordings,
  markCachedAudioRecordingStatus,
  type CachedAudioRecording,
} from "./audio-cache";
import {
  createBrowserAudioRecorder,
  isBrowserAudioRecordingSupported,
  type BrowserAudioRecorder,
} from "./browser-audio-recorder";

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

const FALLBACK_TRANSCRIPTION_MODELS = [...OPENROUTER_TRANSCRIPTION_MODELS];
const FALLBACK_REASONING_EFFORTS = [...OPENROUTER_REASONING_EFFORTS];

const TRANSCRIPT_LEVELS: { key: TranscriptLevelKey; label: string }[] = [
  { key: "literal", label: "Literal" },
  { key: "clean", label: "Clean" },
  { key: "summary", label: "Summary" },
  { key: "brief", label: "Brief" },
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export function AudioModal({ onClose }: { onClose: () => void }) {
  const audio = useAudioImports();
  return (
    <ModalFrame title="Audio" onClose={onClose}>
      <div className="audio-toolbar">
        <div className="segmented">
          <button className={audio.language === "ru" ? "active" : ""} onClick={() => audio.setLanguage("ru")}>
            RU
          </button>
          <button className={audio.language === "en" ? "active" : ""} onClick={() => audio.setLanguage("en")}>
            EN
          </button>
        </div>
        <button className="icon-btn" onClick={audio.refreshAudio} disabled={audio.loading}>
          Refresh
        </button>
      </div>
      <div className="modal-body audio-list">
        {audio.error && <div className="modal-error">{audio.error}</div>}
        <UploadPanel uploadStatus={audio.uploadStatus} onSubmit={audio.uploadFiles} />
        <RecordPanel
          recording={audio.recording}
          cachedRecordings={audio.cachedRecordings}
          onToggle={audio.toggleRecording}
          onFlush={audio.flushCachedUploads}
        />
        {!audio.items.length && !audio.loading && <div className="empty-modal">No uploaded audio yet</div>}
        {audio.items.map((item) => (
          <AudioItem
            key={item.id}
            item={item}
            language={audio.language}
            busy={audio.busyMediaId === item.id}
            models={[]}
            reasoningEfforts={FALLBACK_REASONING_EFFORTS}
            onRetry={(options) => audio.retryTranscription(item.id, options)}
            onDelete={() => audio.deleteAudio(item.id)}
          />
        ))}
      </div>
    </ModalFrame>
  );
}

function UploadPanel({ uploadStatus, onSubmit }: { uploadStatus: string; onSubmit: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submit = useCallback(
    (files: FileList | File[]) => {
      const audioFiles = Array.from(files).filter(isAudioLikeFile);
      if (audioFiles.length) onSubmit(audioFiles);
    },
    [onSubmit],
  );
  return (
    <section
      className="audio-upload-panel"
      tabIndex={0}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        submit(event.dataTransfer.files);
      }}
      onPaste={(event) => submit(event.clipboardData.files)}
    >
      <input
        ref={inputRef}
        className="hidden-file-input"
        type="file"
        accept="audio/*,.m4a,.mp3,.wav,.aac,.caf,.ogg,.opus,.webm,.mp4,.mov"
        multiple
        onChange={(event) => {
          if (event.currentTarget.files) submit(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <div className="audio-upload-main">
        <div>
          <div className="audio-title">Upload audio</div>
          <div className="audio-meta">{uploadStatus || "Drop, paste, or choose files"}</div>
        </div>
        <button className="icon-btn" onClick={() => inputRef.current?.click()}>
          Choose
        </button>
      </div>
    </section>
  );
}

function RecordPanel({
  recording,
  cachedRecordings,
  onToggle,
  onFlush,
}: {
  recording: RecordingUiState;
  cachedRecordings: CachedAudioRecording[];
  onToggle: () => void;
  onFlush: () => void;
}) {
  return (
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
        <button className={`icon-btn ${recording.active ? "danger" : ""}`} onClick={onToggle}>
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
          <button className="mini-action" onClick={onFlush}>
            Upload cached
          </button>
        </div>
      )}
    </section>
  );
}

function AudioItem({
  item,
  language,
  busy,
  models,
  reasoningEfforts,
  onRetry,
  onDelete,
}: {
  item: ImportedAudioInfo;
  language: TranscriptLanguage;
  busy: boolean;
  models: AppSettingsInfo["transcriptionModels"];
  reasoningEfforts: readonly string[];
  onRetry: (options: AudioRetryOptions) => void;
  onDelete: () => void;
}) {
  const transcription = displayTranscription(item);
  const latestAttempt = latestTranscription(item);
  const transcript = transcription?.transcript?.[language];
  const fallbackModel = transcription?.model || models[0]?.id || FALLBACK_TRANSCRIPTION_MODELS[0].id;
  const fallbackEffort = transcription?.reasoningEffort || reasoningEfforts[1] || "medium";
  const [model, setModel] = useState(fallbackModel);
  const [reasoningEffort, setReasoningEffort] = useState(fallbackEffort);
  const modelOptions = models.length
    ? models.some((option) => option.id === model)
      ? models
      : [{ id: model, label: model, description: "Current" }, ...models]
    : FALLBACK_TRANSCRIPTION_MODELS;
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
          <button className="icon-btn" onClick={() => onRetry({ model, reasoningEffort })} disabled={busy}>
            {busy ? "Queued" : "Retry"}
          </button>
          <button className="icon-btn danger" onClick={onDelete} disabled={busy}>
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
      <section
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

// ---------- helpers ----------

export function chooseRecorderMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

export function extensionForMime(mimeType: string) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg")) return "mp3";
  return "webm";
}

export function isAudioLikeFile(file: File) {
  return file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac|caf|ogg|opus|webm|mp4|mov)$/i.test(file.name);
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

// ---------- the data hook (ported from use-audio-imports.ts) ----------

function useAudioImports() {
  const [items, setItems] = useState<ImportedAudioInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState<TranscriptLanguage>("ru");
  const [busyMediaId, setBusyMediaId] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [cachedRecordings, setCachedRecordings] = useState<CachedAudioRecording[]>([]);
  const [recording, setRecording] = useState<RecordingUiState>({
    active: false,
    elapsedMs: 0,
    chunkCount: 0,
    mimeType: "",
    error: "",
  });
  const cachedUploadRunning = useRef(false);
  const cachedRecoveryStarted = useRef(false);
  const mediaRecorderRef = useRef<BrowserAudioRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingChunkIndexRef = useRef(0);
  const recordingChunkWritesRef = useRef<Promise<void>[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  const refreshAudio = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await fetchJson<ImportedAudioInfo[]>("/api/imports/audio"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load audio");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCachedRecordings = useCallback(async () => {
    try {
      setCachedRecordings(await loadCachedAudioRecordings());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load cached recordings");
    }
  }, []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const audioFiles = files.filter(isAudioLikeFile);
      if (!audioFiles.length) {
        setUploadStatus("No audio files selected");
        return;
      }

      setUploadStatus(`Uploading ${audioFiles.length} file${audioFiles.length === 1 ? "" : "s"}`);
      setError("");
      try {
        const form = new FormData();
        for (const file of audioFiles) form.append("audio", file, file.name);
        form.append("source", "browser-file-upload");
        form.append("clientNow", new Date().toISOString());
        const result = await fetchJson<{ audioFiles?: number; mediaFiles?: number }>("/api/imports/audio/upload", {
          method: "POST",
          body: form,
        });
        setUploadStatus(`Uploaded ${result.audioFiles ?? result.mediaFiles ?? audioFiles.length} audio file(s)`);
        await refreshAudio();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not upload audio";
        setError(message);
        setUploadStatus(message);
      }
    },
    [refreshAudio],
  );

  const flushCachedUploads = useCallback(async () => {
    if (cachedUploadRunning.current) return;
    cachedUploadRunning.current = true;
    setError("");
    try {
      const records = await loadCachedAudioRecordings();
      setCachedRecordings(records);
      for (const record of records) {
        if (record.id === recordingIdRef.current || record.status === "uploading") continue;
        await markCachedAudioRecordingStatus(record.id, "uploading");
        await refreshCachedRecordings();
        setUploadStatus(`Uploading cached ${record.filename}`);

        try {
          const blob = await loadCachedAudioBlob(record.id);
          const filename = record.filename || `recording-${record.createdAt}.${extensionForMime(blob.type || record.mimeType)}`;
          const form = new FormData();
          form.append("audio", blob, filename);
          form.append("source", "browser-recording");
          form.append("recordingId", record.id);
          form.append("recordedAt", record.createdAt);
          form.append("durationMs", String(record.durationMs));
          await fetchJson("/api/imports/audio/upload", { method: "POST", body: form });
          await deleteCachedAudioRecording(record.id);
          setUploadStatus(`Uploaded cached ${filename}`);
          await refreshAudio();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not upload cached recording";
          await markCachedAudioRecordingStatus(record.id, "failed", message);
          setUploadStatus(message);
        } finally {
          await refreshCachedRecordings();
        }
      }
    } finally {
      cachedUploadRunning.current = false;
    }
  }, [refreshAudio, refreshCachedRecordings]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== "inactive") {
      try {
        recorder.requestData();
      } catch {
        // Some browsers do not allow requestData while stopping.
      }
      recorder.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (mediaRecorderRef.current?.state === "recording") return;
    if (!navigator.mediaDevices?.getUserMedia || !isBrowserAudioRecordingSupported()) {
      setRecording((current) => ({ ...current, error: "Audio recording is not available in this browser" }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      const mimeType = chooseRecorderMimeType();
      const recorder = createBrowserAudioRecorder(stream, mimeType);
      mediaRecorderRef.current = recorder;
      const recorderMimeType = recorder.mimeType || mimeType || "audio/webm";
      const cached = await createCachedAudioRecording(recorderMimeType, {
        audioCodec: recorder.audioCodec === "pcm-s16le" ? "pcm-s16le" : null,
        sampleRate: recorder.sampleRate ?? null,
      });
      recordingIdRef.current = cached.id;
      recordingStartedAtRef.current = Date.now();
      recordingChunkIndexRef.current = 0;
      recordingChunkWritesRef.current = [];
      setUploadStatus("");
      setRecording({
        active: true,
        elapsedMs: 0,
        chunkCount: 0,
        mimeType: recorderMimeType,
        error: "",
      });
      await refreshCachedRecordings();

      recorder.ondataavailable = (event) => {
        if (!event.data.size || !recordingIdRef.current) return;
        const index = recordingChunkIndexRef.current;
        recordingChunkIndexRef.current += 1;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        const write = appendCachedAudioChunk(recordingIdRef.current, index, event.data, elapsedMs).catch((err) => {
          setRecording((current) => ({
            ...current,
            error: err instanceof Error ? err.message : "Could not cache recording chunk",
          }));
        });
        recordingChunkWritesRef.current.push(write);
        setRecording((current) => ({ ...current, elapsedMs, chunkCount: index + 1 }));
      };
      recorder.onerror = (err) => {
        setRecording((current) => ({
          ...current,
          error: err.message || "Recording failed",
        }));
      };
      recorder.onstop = () => {
        const recordingId = recordingIdRef.current;
        const elapsedMs = Date.now() - recordingStartedAtRef.current;
        if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        recordingStreamRef.current = null;
        recordingIdRef.current = null;
        const chunkWrites = recordingChunkWritesRef.current;
        recordingChunkWritesRef.current = [];
        setRecording((current) => ({ ...current, active: false, elapsedMs }));
        if (recordingId) {
          void Promise.allSettled(chunkWrites)
            .then(() => finalizeCachedAudioRecording(recordingId, elapsedMs))
            .then(refreshCachedRecordings)
            .then(flushCachedUploads)
            .catch((err) => {
              setRecording((current) => ({
                ...current,
                error: err instanceof Error ? err.message : "Could not finalize recording",
              }));
            });
        }
      };
      await recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        setRecording((current) => ({ ...current, elapsedMs: Date.now() - recordingStartedAtRef.current }));
      }, 1000);
    } catch (err) {
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        try {
          await recorder.close?.();
        } catch {
          // Best-effort cleanup after a failed start.
        }
        mediaRecorderRef.current = null;
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setRecording((current) => ({
        ...current,
        active: false,
        error: err instanceof Error ? err.message : "Could not start audio recording",
      }));
    }
  }, [flushCachedUploads, refreshCachedRecordings]);

  const toggleRecording = useCallback(() => {
    if (recording.active) stopRecording();
    else void startRecording();
  }, [recording.active, startRecording, stopRecording]);

  const retryTranscription = useCallback(
    async (mediaId: string, options: AudioRetryOptions) => {
      setBusyMediaId(mediaId);
      setError("");
      try {
        await fetchJson<AudioTranscriptionInfo>("/api/imports/audio/transcriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mediaId, ...options }),
        });
        await refreshAudio();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not queue transcription");
      } finally {
        setBusyMediaId("");
      }
    },
    [refreshAudio],
  );

  const deleteAudio = useCallback(async (mediaId: string) => {
    if (!window.confirm("Delete this audio and its transcriptions?")) return;
    setBusyMediaId(mediaId);
    setError("");
    try {
      await fetchJson(`/api/imports/audio?mediaId=${encodeURIComponent(mediaId)}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== mediaId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete audio");
    } finally {
      setBusyMediaId("");
    }
  }, []);

  // Refresh on mount.
  useEffect(() => {
    void refreshAudio();
    void refreshCachedRecordings();
  }, [refreshAudio, refreshCachedRecordings]);

  // One-time sweep of cached recordings on first mount.
  useEffect(() => {
    if (cachedRecoveryStarted.current) return;
    cachedRecoveryStarted.current = true;
    void refreshCachedRecordings().then(flushCachedUploads);
  }, [flushCachedUploads, refreshCachedRecordings]);

  // Poll for queued/processing transcriptions.
  useEffect(() => {
    const hasPending = items.some((item) =>
      item.transcriptions.some((t) => t.status === "queued" || t.status === "processing"),
    );
    if (!hasPending) return;
    const id = window.setInterval(refreshAudio, 4000);
    return () => window.clearInterval(id);
  }, [items, refreshAudio]);

  // Recording cleanup on unmount + flush on visibility/unload.
  useEffect(() => {
    const flushActiveRecording = () => {
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        try {
          recorder.requestData();
        } catch {
          return;
        }
      }
    };
    document.addEventListener("visibilitychange", flushActiveRecording);
    window.addEventListener("beforeunload", flushActiveRecording);
    return () => {
      document.removeEventListener("visibilitychange", flushActiveRecording);
      window.removeEventListener("beforeunload", flushActiveRecording);
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current);
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.requestData();
          void recorder.stop();
        } catch {
          // Ignore cleanup errors while leaving the page.
        }
      }
    };
  }, []);

  return {
    items,
    loading,
    error,
    language,
    setLanguage,
    busyMediaId,
    uploadStatus,
    recording,
    cachedRecordings,
    refreshAudio,
    uploadFiles,
    flushCachedUploads,
    toggleRecording,
    retryTranscription,
    deleteAudio,
  };
}
