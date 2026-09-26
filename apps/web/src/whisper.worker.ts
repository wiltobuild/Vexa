import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

env.allowLocalModels = false;
// One thread works on static hosts without cross-origin isolation headers.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
let transcriber: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
self.onmessage = async (event: MessageEvent<{ audio: Float32Array }>) => {
  try {
    transcriber ??= pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en",
      {
        device: "wasm",
        dtype: "q8",
        progress_callback: (progress) => {
          if (progress.status === "progress")
            self.postMessage({
              type: "progress",
              message: `Loading Whisper · ${Math.round(progress.progress)}% of ${progress.file}`,
            });
        },
      },
    );
    const model = await transcriber;
    self.postMessage({
      type: "progress",
      message: "Whisper is transcribing on your device…",
    });
    const output = await model(event.data.audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const result = Array.isArray(output) ? output[0] : output;
    self.postMessage({
      type: "result",
      text: result.text,
      segments:
        result.chunks?.map(
          (chunk: {
            timestamp: [number | null, number | null];
            text: string;
          }) => ({
            start: chunk.timestamp[0] ?? 0,
            end: chunk.timestamp[1] ?? event.data.audio.length / 16000,
            text: chunk.text,
          }),
        ) ?? [],
    });
  } catch {
    transcriber = undefined;
    self.postMessage({
      type: "error",
      message:
        "Whisper could not load or transcribe. Check your connection for the first model download, then try a short English recording.",
    });
  }
};
