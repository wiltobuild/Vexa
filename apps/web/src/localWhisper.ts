export async function decodeAudio(blob: Blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration > 120)
      throw new Error("Please choose a recording under two minutes.");
    const offline = new OfflineAudioContext(
      1,
      Math.ceil(decoded.duration * 16000),
      16000,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    await context.close();
  }
}
export function transcribeLocally(
  audio: Float32Array,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<{
  text: string;
  segments: { start: number; end: number; text: string }[];
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
    };
    const abort = () => {
      finish();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timeout = setTimeout(
      () => {
        finish();
        reject(
          new Error(
            "Whisper took too long. Try a shorter clip or the connected workspace.",
          ),
        );
      },
      5 * 60 * 1000,
    );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      finish();
      reject(
        new Error(
          "On-device Whisper is unavailable in this browser. Try Chrome or the connected workspace.",
        ),
      );
    };
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        onProgress(data.message);
        return;
      }
      finish();
      if (data.type === "result" && data.text?.trim()) resolve(data);
      else
        reject(
          new Error(
            data.message ?? "No speech was found. Try another recording.",
          ),
        );
    };
    onProgress(
      "Loading on-device Whisper. The first use downloads the English model…",
    );
    worker.postMessage({ audio }, [audio.buffer]);
  });
}
