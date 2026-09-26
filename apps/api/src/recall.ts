import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export type Transcript = {
  id: string;
  text: string;
  segments: { start: number; end: number; text: string }[];
  created_at: string;
};
type Dependencies = {
  key: () => string | undefined;
  nextId: () => string;
  save: (userId: string, record: Transcript) => Promise<void>;
  list: (userId: string) => Promise<Transcript[]>;
  remove: (userId: string, id: string) => Promise<boolean>;
  fetch?: typeof fetch;
};
// Inspect container signatures instead of trusting a browser-supplied MIME type or filename.
export function audioFormat(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WAVE"
  )
    return "wav";
  if (b.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (b.subarray(0, 4).toString() === "OggS") return "ogg";
  if (b.subarray(0, 4).toString() === "fLaC") return "flac";
  if (b.subarray(4, 8).toString() === "ftyp") return "mp4";
  if (
    b.subarray(0, 3).toString() === "ID3" ||
    (b[0] === 255 && (b[1] & 0xe0) === 0xe0)
  )
    return "mp3";
  return null;
}
const resultSchema = z.object({
  text: z.string().trim().min(1).max(50000),
  duration: z.number().nonnegative().max(130),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string().max(10000),
      }),
    )
    .max(1000)
    .default([]),
});
export async function registerRecall(app: FastifyInstance, deps: Dependencies) {
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_AUDIO_BYTES },
  });
  const active = new Set<string>();
  app.get("/me/transcriptions/status", async () => ({
    available: !!deps.key(),
    model: "whisper-1",
    maxSeconds: 120,
    maxBytes: MAX_AUDIO_BYTES,
  }));
  app.get("/me/transcriptions", async (req) => deps.list(req.userId));
  app.delete("/me/transcriptions/:id", async (req, reply) => {
    const { id } = z
      .object({ id: z.string().regex(/^\d{1,20}$/) })
      .parse(req.params);
    if (!(await deps.remove(req.userId, id)))
      return reply.code(404).send({ error: "Transcript not found" });
    return reply.code(204).send();
  });
  app.post(
    "/me/transcriptions",
    {
      bodyLimit: MAX_AUDIO_BYTES + 65536,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          keyGenerator: (req) => req.userId,
        },
      },
    },
    async (req, reply) => {
      if (req.headers["x-vexa-consent"] !== "microphone-transcription")
        return reply
          .code(400)
          .send({ error: "Explicit transcription consent is required" });
      const key = deps.key();
      if (!key)
        return reply
          .code(503)
          .send({
            error:
              "Whisper is not configured. Set OPENAI_API_KEY on the API server.",
          });
      if (active.has(req.userId))
        return reply
          .code(429)
          .send({ error: "A transcription is already in progress" });
      active.add(req.userId);
      const controller = new AbortController();
      const disconnected = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.on("close", disconnected);
      try {
        let bytes: Buffer | undefined;
        for await (const part of req.parts()) {
          if (part.type !== "file" || part.fieldname !== "audio")
            return reply.code(400).send({ error: "Send one audio recording" });
          bytes = await part.toBuffer();
        }
        const format = bytes && audioFormat(bytes);
        if (!bytes || !format)
          return reply
            .code(415)
            .send({
              error:
                "Choose a WAV, WebM, MP3, MP4, Ogg or FLAC audio recording",
            });
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(bytes)]),
          `recording.${format}`,
        );
        form.append("model", "whisper-1");
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "segment");
        const response = await (deps.fetch ?? fetch)(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(60000),
            ]),
          },
        );
        if (!response.ok)
          return reply
            .code(response.status === 429 ? 429 : 502)
            .send({
              error:
                response.status === 429
                  ? "Whisper is busy. Please retry shortly."
                  : "Whisper could not transcribe this recording. Please try again.",
            });
        const parsed = resultSchema.safeParse(await response.json());
        if (!parsed.success)
          return reply
            .code(422)
            .send({
              error:
                "No usable speech found, or the recording exceeds two minutes.",
            });
        if (controller.signal.aborted) return;
        const { text, segments } = parsed.data;
        const record = {
          id: deps.nextId(),
          text,
          segments,
          created_at: new Date().toISOString(),
        };
        await deps.save(req.userId, record);
        return reply.code(201).send(record);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode) throw error;
        return reply
          .code(502)
          .send({ error: "Transcription did not finish. Please retry." });
      } finally {
        active.delete(req.userId);
        reply.raw.off("close", disconnected);
      }
    },
  );
}
