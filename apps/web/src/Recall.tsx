import { useEffect, useRef, useState } from "react";

import {
  Download,
  FileText,
  Mic,
  Play,
  Search,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";

import { AvatarArt } from "./avatars";

type Segment = { start: number; end: number; text: string; speaker?: string };

type Transcript = {
  id: string;
  text: string;
  segments: Segment[];
  created_at: string;
};

const sample: Segment[] = [
  {
    speaker: "nova",
    start: 4,
    end: 10,
    text: "Alright, let’s get everyone together. Same plan as last time?",
  },

  {
    speaker: "ghost",
    start: 12,
    end: 17,
    text: "I’ll take the left side. Kira, can you cover mid?",
  },

  {
    speaker: "kira",
    start: 18,
    end: 24,
    text: "On it. Let’s wait for pixel before we push.",
  },

  {
    speaker: "pixel",
    start: 25,
    end: 31,
    text: "I’m here. We should save our abilities for the final round.",
  },

  {
    speaker: "nova",
    start: 33,
    end: 38,
    text: "Good call. Let’s rotate together and play for the objective.",
  },
];

const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export default function Recall({
  demo = false,
  apiBase = "/api",
  speaker = "You",
  channel = "The Lounge",
}: {
  demo?: boolean;
  apiBase?: string;
  speaker?: string;
  channel?: string;
}) {
  const [mode, setMode] = useState<"sample" | "local">("sample");
  const isSample = demo && mode === "sample";

  const [records, setRecords] = useState<Transcript[]>([]),
    [selected, setSelected] = useState<Transcript | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");

  const [available, setAvailable] = useState(demo),
    [loading, setLoading] = useState(!demo),
    [consent, setConsent] = useState(false),
    [phase, setPhase] = useState<
      "idle" | "starting" | "recording" | "transcribing" | "replaying"
    >("idle"),
    [seconds, setSeconds] = useState(0),
    [sampleCount, setSampleCount] = useState(sample.length);

  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    request = useRef<AbortController | null>(null),
    generation = useRef(0);

  const endpoint = `${apiBase.replace(/\/$/, "")}/me/transcriptions`;

  const stopTracks = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  const cancel = () => {
    generation.current++;
    clearInterval(timer.current);
    if (recorder.current) {
      recorder.current.onstop = null;
      if (recorder.current.state !== "inactive") recorder.current.stop();
      recorder.current = null;
    }
    stopTracks();
    request.current?.abort();
    setPhase("idle");
  };

  useEffect(() => {
    if (demo) return;
    const ac = new AbortController();
    Promise.all([
      fetch(endpoint + "/status", {
        credentials: "include",
        signal: ac.signal,
      }),
      fetch(endpoint, { credentials: "include", signal: ac.signal }),
    ])
      .then(async ([status, history]) => {
        if (!status.ok || !history.ok)
          throw new Error("Could not load Recall. Close and reopen to retry.");
        const config = await status.json();
        const rows = await history.json();
        if (ac.signal.aborted) return;
        setAvailable(config.available);
        setRecords(rows);
        setSelected(rows[0] ?? null);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [demo, endpoint]);

  useEffect(
    () => () => {
      generation.current++;
      clearInterval(timer.current);
      if (recorder.current) {
        recorder.current.onstop = null;
        if (recorder.current.state !== "inactive") recorder.current.stop();
      }
      stopTracks();
      request.current?.abort();
    },
    [],
  );

  async function transcribe(blob: Blob) {
    if (blob.size > 10 * 1024 * 1024) {
      setError("Audio must be smaller than 10 MB.");
      setPhase("idle");
      return;
    }

    if (!blob.size) {
      setError("The recording was empty. Please try again.");
      setPhase("idle");
      return;
    }

    setPhase("transcribing");
    setError("");
    const ac = new AbortController();
    request.current = ac;

    try {
      if (demo) {
        const { decodeAudio, transcribeLocally } =
          await import("./localWhisper");
        const audio = await decodeAudio(blob);
        if (ac.signal.aborted) return;
        const result = await transcribeLocally(audio, ac.signal, setNotice);
        if (ac.signal.aborted) return;
        const data = {
          ...result,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
        };
        setRecords((old) => [data, ...old].slice(0, 20));
        setSelected(data);
        setQuery("");
        setNotice(
          "Transcribed on your device. Download to keep this note before leaving Recall.",
        );
        return;
      }
      const form = new FormData();
      form.append("audio", blob, "recording");
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "X-Vexa-Consent": "microphone-transcription" },
        body: form,
        signal: ac.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Transcription failed");
      if (ac.signal.aborted) return;
      setRecords((old) => [data, ...old]);
      setSelected(data);
      setQuery("");
      setNotice("Transcript saved to your private history.");
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ac.signal.aborted) setPhase("idle");
    }
  }

  async function start() {
    setError("");
    setNotice("");
    setPhase("starting");
    const token = ++generation.current;

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Microphone recording needs a supported browser on HTTPS or localhost. You can upload audio instead.",
        );

      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (token !== generation.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;

      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(
        media,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = rec;
      const chunks: Blob[] = [];
      let size = 0;

      rec.ondataavailable = (e) => {
        if (e.data.size) {
          chunks.push(e.data);
          size += e.data.size;
          if (size >= 10 * 1024 * 1024 && rec.state === "recording") rec.stop();
        }
      };

      rec.onstop = () => {
        clearInterval(timer.current);
        stopTracks();
        recorder.current = null;
        void transcribe(new Blob(chunks, { type: rec.mimeType }));
      };

      rec.onerror = () => {
        cancel();
        setError("The microphone stopped unexpectedly. Please record again.");
      };

      rec.start(1000);
      setSeconds(0);
      setPhase("recording");
      const started = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= 120 && rec.state === "recording") rec.stop();
      }, 250);
    } catch (e) {
      if (token === generation.current) {
        stopTracks();
        setPhase("idle");
        setError(
          (e as Error).name === "NotAllowedError"
            ? "Microphone access was denied. Allow access in your browser, or upload audio."
            : (e as Error).message,
        );
      }
    }
  }

  async function useExample() {
    const token = ++generation.current;
    setPhase("starting");
    setError("");
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}recall-sample.wav`,
      );
      if (!response.ok) throw new Error("Could not load the example audio.");
      const blob = await response.blob();
      if (token === generation.current) await transcribe(blob);
    } catch (e) {
      if (token === generation.current) {
        setError((e as Error).message);
        setPhase("idle");
      }
    }
  }
  function replay() {
    setQuery("");
    setPhase("replaying");
    setSampleCount(0);
    let count = 0;
    timer.current = setInterval(() => {
      count++;
      setSampleCount(count);
      if (count === sample.length) {
        clearInterval(timer.current);
        setPhase("idle");
        setNotice(
          "Sample complete. Search, copy or download the conversation.",
        );
      }
    }, 900);
  }
  const segments = isSample
    ? sample.slice(0, sampleCount)
    : selected?.segments.length
      ? selected.segments
      : selected
        ? [{ start: 0, end: 0, text: selected.text }]
        : [];

  const filtered = segments.filter((s) =>
    `${s.text} ${s.speaker ?? speaker}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  const plain = segments
    .map((s) => `[${time(s.start)}] ${s.speaker ?? speaker}: ${s.text}`)
    .join("\n");

  function download() {
    const url = URL.createObjectURL(
      new Blob([plain], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = isSample
      ? "vexa-recall-sample.txt"
      : `vexa-recall-${selected?.id}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove() {
    if (!selected) return;
    setError("");
    try {
      if (demo) {
        const remaining = records.filter((r) => r.id !== selected.id);
        setRecords(remaining);
        setSelected(remaining[0] ?? null);
        setNotice("Transcript deleted.");
        return;
      }
      const response = await fetch(`${endpoint}/${selected.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok)
        throw new Error("Could not delete transcript. Please retry.");
      const remaining = records.filter((r) => r.id !== selected.id);
      setRecords(remaining);
      setSelected(remaining[0] ?? null);
      setNotice("Transcript deleted.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="recall">
      <div className="voice-hero">
        <span className="eyebrow">VEXA RECALL · WHISPER</span>
        <h2>
          Great moments.
          <br />
          <span>Nothing lost.</span>
        </h2>
        <p>
          {isSample
            ? "Catch every callout. Find the moment that matters."
            : "Turn your voice into words you can come back to."}
        </p>
        <span className="sample-badge">
          {isSample
            ? "Sample transcript · Preview"
            : demo
              ? "On-device Whisper · English"
              : "Private voice notes · whisper-1"}
        </span>
      </div>

      {demo && (
        <div className="button-row recall-tabs" aria-label="Recall mode">
          <button
            className={isSample ? "primary-button" : "secondary-button"}
            aria-pressed={isSample}
            onClick={() => {
              cancel();
              setMode("sample");
              setQuery("");
              setError("");
              setNotice("");
            }}
          >
            Sample showcase
          </button>
          <button
            className={!isSample ? "primary-button" : "secondary-button"}
            aria-pressed={!isSample}
            onClick={() => {
              cancel();
              setMode("local");
              setQuery("");
              setError("");
              setNotice("");
            }}
          >
            Try my microphone
          </button>
        </div>
      )}

      <div className="recall-controls">
        {isSample ? (
          <>
            <p>
              Showcase a scripted squad conversation. No microphone or API key
              needed.
            </p>
            <button
              className="primary-button"
              disabled={phase === "replaying"}
              onClick={replay}
            >
              <Play size={16} />
              {phase === "replaying"
                ? "Playing sample…"
                : "Replay transcription demo"}
            </button>
            <p className="muted-text">
              Choose “Try my microphone” for real, on-device Whisper
              transcription.
            </p>
          </>
        ) : (
          <>
            <p>
              {demo
                ? "Whisper runs in your browser. First use downloads an English model from Hugging Face; your audio stays on this device. Notes stay in this view until you leave. Download to keep them."
                : "Your microphone or uploaded audio goes to OpenAI only after you choose to transcribe. Vexa stores the text privately for 30 days; it does not save the audio. This records a voice note, not a group call."}
            </p>
            {loading ? (
              <p role="status">Loading Recall…</p>
            ) : !available ? (
              <p className="notice">
                Whisper needs an OPENAI_API_KEY on your Vexa API server.
              </p>
            ) : (
              <>
                <label className="consent-label">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => {
                      setConsent(e.target.checked);
                      if (!e.target.checked) cancel();
                    }}
                  />
                  {demo
                    ? "I agree to record or process my audio on this device."
                    : "I consent to transcription and have permission to submit this audio."}
                </label>
                <div className="button-row">
                  {phase === "recording" ? (
                    <button
                      className="danger-button"
                      onClick={() => recorder.current?.stop()}
                    >
                      <Square size={16} />
                      Stop & transcribe · {time(seconds)}
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={!consent || phase !== "idle"}
                      onClick={() => void start()}
                    >
                      <Mic size={16} />
                      {phase === "starting"
                        ? "Opening microphone…"
                        : phase === "transcribing"
                          ? "Transcribing with Whisper…"
                          : "Record voice note"}
                    </button>
                  )}
                  <label
                    className={`secondary-button ${!consent || phase !== "idle" ? "disabled" : ""}`}
                  >
                    Upload audio
                    <input
                      aria-label="Upload audio"
                      type="file"
                      accept="audio/*,.webm,.mp4"
                      disabled={!consent || phase !== "idle"}
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void transcribe(file);
                      }}
                    />
                  </label>
                  {demo && (
                    <button
                      className="secondary-button"
                      disabled={!consent || phase !== "idle"}
                      onClick={() => void useExample()}
                    >
                      Transcribe example audio
                    </button>
                  )}
                  {phase !== "idle" && (
                    <button className="secondary-button" onClick={cancel}>
                      Cancel
                    </button>
                  )}
                </div>
                <small>
                  Up to 2 minutes / 10 MB. Your microphone stops automatically.
                </small>
              </>
            )}
          </>
        )}

        {phase === "recording" && (
          <p className="recording-state" role="status">
            <span />
            Recording your microphone · {time(seconds)}
          </p>
        )}
        {phase === "transcribing" && (
          <p role="status">Listening back and finding the words…</p>
        )}
        {error && (
          <p role="alert" className="recall-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="muted-text">
            {notice}
          </p>
        )}
      </div>

      {!isSample && records.length > 0 && (
        <label className="field-label">
          {demo ? "LOCAL NOTES" : "PRIVATE HISTORY"}
          <select
            className="form-input"
            value={selected?.id ?? ""}
            onChange={(e) => {
              setSelected(records.find((r) => r.id === e.target.value) ?? null);
              setQuery("");
            }}
          >
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.created_at).toLocaleString()} ·{" "}
                {r.text.slice(0, 40)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="transcript-card">
        <div className="transcript-title">
          <span className="voice-orb">
            <Volume2 size={24} />
          </span>
          <div>
            <h3>{isSample ? channel : "Your voice note"}</h3>
            <p>
              {isSample
                ? "Community night · 4 speakers · 38 sec"
                : selected
                  ? new Date(selected.created_at).toLocaleString()
                  : "Record something worth remembering"}
            </p>
          </div>
        </div>
        <label className="transcript-search">
          <Search size={17} />
          <input
            aria-label="Search transcript"
            placeholder="Search this conversation"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div
          className="transcript-lines"
          aria-live={phase === "replaying" ? "polite" : "off"}
        >
          {filtered.map((s, i) => (
            <div className="transcript-line" key={`${s.start}-${i}`}>
              <span>{time(s.start)}</span>
              {isSample ? (
                <AvatarArt id={s.speaker!} size={28} />
              ) : (
                <FileText size={24} />
              )}
              <div>
                <strong>{s.speaker ?? speaker}</strong>
                <p>{s.text}</p>
              </div>
            </div>
          ))}
          {!filtered.length && (
            <p className="empty-state">
              {query
                ? "No matching moments. Try another phrase."
                : phase === "replaying"
                  ? "Listening to the sample…"
                  : "Your transcript will appear here."}
            </p>
          )}
        </div>
        <div className="recall-actions">
          <button
            className="secondary-button"
            disabled={!plain}
            onClick={() =>
              navigator.clipboard
                .writeText(plain)
                .then(() => setNotice("Transcript copied."))
                .catch(() =>
                  setError(
                    "Copy unavailable. Download the transcript instead.",
                  ),
                )
            }
          >
            Copy transcript
          </button>
          <button
            className="secondary-button"
            disabled={!plain}
            onClick={download}
          >
            <Download size={15} />
            Download
          </button>
          {!isSample && selected && (
            <button
              className="icon-button"
              aria-label="Delete transcript"
              onClick={() => void remove()}
            >
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
