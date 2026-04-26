export type BrowserAudioRecorder = {
  readonly audioCodec: "native" | "pcm-s16le";
  readonly mimeType: string;
  readonly sampleRate?: number;
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((error: Error) => void) | null;
  onstop: (() => void) | null;
  close?: () => void | Promise<void>;
  requestData: () => void;
  start: (timesliceMs?: number) => void | Promise<void>;
  stop: () => void | Promise<void>;
};

export const PCM_AUDIO_CHUNK_MIME_TYPE = "application/x-chatview-pcm-s16le";
export const PCM_AUDIO_MIME_TYPE = "audio/wav";

export function isBrowserAudioRecordingSupported() {
  return typeof MediaRecorder !== "undefined" || getAudioContextConstructor() !== null;
}

export function createBrowserAudioRecorder(stream: MediaStream, mimeType: string): BrowserAudioRecorder {
  if (typeof MediaRecorder !== "undefined") {
    try {
      return new NativeAudioRecorder(stream, mimeType);
    } catch {
      // Fall through to the PCM recorder for browsers with a partial MediaRecorder.
    }
  }

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) throw new Error("Audio recording is not available in this browser");
  return new PcmAudioRecorder(stream, AudioContextCtor);
}

class NativeAudioRecorder implements BrowserAudioRecorder {
  readonly audioCodec = "native" as const;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onstop: (() => void) | null = null;
  private readonly recorder: MediaRecorder;

  constructor(stream: MediaStream, mimeType: string) {
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event) => this.ondataavailable?.({ data: event.data });
    this.recorder.onerror = (event) => {
      const errorEvent = event as ErrorEvent;
      const error = errorEvent.error instanceof Error
        ? errorEvent.error
        : new Error(errorEvent.message || "Recording failed");
      this.onerror?.(error);
    };
    this.recorder.onstop = () => this.onstop?.();
  }

  get mimeType() {
    return this.recorder.mimeType;
  }

  get state() {
    return this.recorder.state;
  }

  requestData() {
    this.recorder.requestData();
  }

  start(timesliceMs?: number) {
    this.recorder.start(timesliceMs);
  }

  stop() {
    this.recorder.stop();
  }

  close() {
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }
}

class PcmAudioRecorder implements BrowserAudioRecorder {
  readonly audioCodec = "pcm-s16le" as const;
  readonly mimeType = PCM_AUDIO_MIME_TYPE;
  readonly sampleRate: number;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" | "paused" = "inactive";

  private readonly context: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly processor: ScriptProcessorNode;
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private flushTimer: number | null = null;
  private closed = false;

  constructor(stream: MediaStream, AudioContextCtor: AudioContextConstructor) {
    this.context = new AudioContextCtor();
    this.sampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (this.state !== "recording") return;
      const input = event.inputBuffer.getChannelData(0);
      this.pending.push(new Float32Array(input));
      this.pendingSamples += input.length;
      event.outputBuffer.getChannelData(0).fill(0);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async start(timesliceMs = 1000) {
    if (this.state === "recording") return;
    this.state = "recording";
    try {
      await this.context.resume();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (timesliceMs > 0) {
      this.flushTimer = window.setInterval(() => this.requestData(), timesliceMs);
    }
  }

  requestData() {
    if (!this.pendingSamples) return;
    const data = encodePcm16Chunk(this.pending, this.pendingSamples);
    this.pending = [];
    this.pendingSamples = 0;
    this.ondataavailable?.({
      data: new Blob([data], { type: PCM_AUDIO_CHUNK_MIME_TYPE }),
    });
  }

  async stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.requestData();
    await this.close();
    this.onstop?.();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      window.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.source.disconnect();
    this.processor.disconnect();
    this.processor.onaudioprocess = null;
    await this.context.close().catch(() => {});
  }
}

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  const win = window as Window & typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

function encodePcm16Chunk(chunks: Float32Array[], sampleCount: number) {
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}
