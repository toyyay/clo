import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioTranscriptionInfo, ImportedAudioInfo } from "../../packages/shared/types";
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
  chooseRecorderMimeType,
  extensionForMime,
  isAudioLikeFile,
  type AudioRetryOptions,
  type RecordingUiState,
  type TranscriptLanguage,
} from "./audio-panel";
import { fetchJson } from "./app-utils";
import {
  createBrowserAudioRecorder,
  isBrowserAudioRecordingSupported,
  type BrowserAudioRecorder,
} from "./browser-audio-recorder";

type UseAudioImportsOptions = {
  isAuthenticated: boolean;
  audioOpen: boolean;
};

export function useAudioImports({ isAuthenticated, audioOpen }: UseAudioImportsOptions) {
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
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load audio");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshCachedRecordings = useCallback(async () => {
    try {
      setCachedRecordings(await loadCachedAudioRecordings());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not load cached recordings");
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not upload audio";
        setError(message);
        setUploadStatus(message);
      }
    },
    [refreshAudio],
  );

  const flushCachedUploads = useCallback(async () => {
    if (!isAuthenticated || cachedUploadRunning.current) return;
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
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not upload cached recording";
          await markCachedAudioRecordingStatus(record.id, "failed", message);
          setUploadStatus(message);
        } finally {
          await refreshCachedRecordings();
        }
      }
    } finally {
      cachedUploadRunning.current = false;
    }
  }, [isAuthenticated, refreshAudio, refreshCachedRecordings]);

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
        const write = appendCachedAudioChunk(recordingIdRef.current, index, event.data, elapsedMs).catch((error) => {
          setRecording((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Could not cache recording chunk",
          }));
        });
        recordingChunkWritesRef.current.push(write);
        setRecording((current) => ({ ...current, elapsedMs, chunkCount: index + 1 }));
      };
      recorder.onerror = (error) => {
        setRecording((current) => ({
          ...current,
          error: error.message || "Recording failed",
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
            .catch((error) => {
              setRecording((current) => ({
                ...current,
                error: error instanceof Error ? error.message : "Could not finalize recording",
              }));
            });
        }
      };
      await recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        setRecording((current) => ({ ...current, elapsedMs: Date.now() - recordingStartedAtRef.current }));
      }, 1000);
    } catch (error) {
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
        error: error instanceof Error ? error.message : "Could not start audio recording",
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
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not queue transcription");
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
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete audio");
    } finally {
      setBusyMediaId("");
    }
  }, []);

  useEffect(() => {
    if (audioOpen) refreshAudio();
  }, [audioOpen, refreshAudio]);

  useEffect(() => {
    if (audioOpen) refreshCachedRecordings();
  }, [audioOpen, refreshCachedRecordings]);

  useEffect(() => {
    if (!isAuthenticated || cachedRecoveryStarted.current) return;
    cachedRecoveryStarted.current = true;
    void refreshCachedRecordings().then(flushCachedUploads);
  }, [flushCachedUploads, isAuthenticated, refreshCachedRecordings]);

  useEffect(() => {
    if (!audioOpen) return;
    const hasPending = items.some((item) =>
      item.transcriptions.some((transcription) => transcription.status === "queued" || transcription.status === "processing"),
    );
    if (!hasPending) return;
    const id = window.setInterval(refreshAudio, 4000);
    return () => window.clearInterval(id);
  }, [items, audioOpen, refreshAudio]);

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

  useEffect(() => {
    if (isAuthenticated) return;
    cachedRecoveryStarted.current = false;
  }, [isAuthenticated]);

  return {
    items,
    loading,
    error,
    language,
    busyMediaId,
    uploadStatus,
    recording,
    cachedRecordings,
    setLanguage,
    refreshAudio,
    uploadFiles,
    flushCachedUploads,
    toggleRecording,
    retryTranscription,
    deleteAudio,
  };
}
