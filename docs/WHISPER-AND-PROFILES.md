# Whisper and character profiles

## Showcase

Run `pnpm install` and `pnpm dev`, then open `http://127.0.0.1:5173`.

1. Open **Voice history**. **Replay transcription demo** animates a clearly labeled, scripted squad conversation. Search, copy and download work.
2. Choose **Try my microphone**, check the consent box, then **Record voice note** or **Transcribe example audio**. This runs real Whisper Tiny English locally in a Web Worker. The first use downloads model weights from Hugging Face and loads the bundled WebAssembly runtime. Subsequent loads can use the browser cache. No account or API key is needed, and audio never leaves the device. This requires a modern browser, internet for the initial model download, and HTTPS/localhost for the microphone. Chrome is the tested browser.
3. Stop to transcribe. Search timestamps, copy or download. Local notes are intentionally ephemeral: leaving Recall discards them. Cancel, leaving Recall, or withdrawing consent stops the microphone/worker. The microphone stops automatically after two minutes.
4. Open **Your profile**, choose one of 12 original characters, optionally remix its colors/signature, and save. The choice persists across reloads and appears throughout the demo. Each of the nine sample people starts with a distinct character.

The included WAV speaks original test text: “Hello squad. Let us play together and defend the objective.” It was synthesized with Windows System.Speech for a reproducible audio-to-text demonstration. The scripted squad transcript is separate and is never presented as model output.

## Connected mode

Apply `pnpm db:migrate` and start the API/gateway/database/Redis. Put `OPENAI_API_KEY` in the server's `.env`; do not expose it through a `VITE_*` variable. Open the connected workspace and choose **Voice Recall**.

- An authenticated, same-origin multipart request sends one recording to OpenAI's `whisper-1` transcription endpoint with `verbose_json` segment timestamps. The server checks explicit consent, container signature and a 10 MB upload limit. Recordings are limited to two minutes; server responses longer than 130 seconds (encoding tolerance) are rejected.
- Limits: five requests per account per minute, one in-flight request per API instance/account, 60-second provider timeout. Per-instance concurrency is not a distributed quota.
- Audio is held in memory for the request and is not written to Vexa storage. OpenAI's provider data handling applies to connected uploads.
- Text and timestamps live in `personal_transcripts`, visible only to their owner. Read/delete always use the authenticated user ID. Notes older than 30 days disappear from reads; an hourly cleanup plus startup cleanup deletes expired rows. A stopped service cannot run cleanup until restarted.
- Search currently filters the selected note locally. History returns the newest 100 unexpired notes. This is a personal voice-note feature, not group-call recording, diarization, or live captions.
- A profile button opens the same character picker. `PATCH /me` validates the character key and saves avatar and bio in Postgres. Existing accounts without a chosen avatar immediately render a stable identity derived from their user ID; no account migration or external image service is necessary.

## Reliability fixes

Message insert/update/delete triggers now write a `message_outbox` event in the same database transaction. One publisher across API instances takes an advisory lock, delivers events through the existing Redis ordered stream, and deletes delivered rows. Failures roll back the batch and retry after five seconds. A crash after publication can cause duplicate delivery; clients reconcile by message ID/nonce. This is at-least-once delivery, not exactly once. Reaction changes now use the same outbox and shared demo/connected picker; see BACKEND.md. Typing remains ephemeral.

Mobile Voice History now closes the navigation drawer. Connected administrator permissions expose the moderation controls their permissions allow. Message history and gateway events include avatar selections so historical authors also render correctly.

## Validation

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` cover the default checks. Backend integration requires the stack and `VEXA_INTEGRATION=1` (CI provides it).

To exercise the actual browser model, set `VEXA_LOCAL_WHISPER_AUDIO` to the absolute path of `apps/web/public/recall-sample.wav`, then run `pnpm test:e2e`. This optional check downloads model weights and requires internet; ordinary tests do not pretend to test model inference. API unit tests stub the provider and verify the real multipart route, model/request shape, ownership, consent, size/signature failures, provider failures, and concurrency. Browser API fixtures are explicitly labeled as such.

## Still needed for a complete community platform

Real multi-person voice/video/screen sharing and channel-consented transcription still require the SFU and two-peer acceptance tests described in `VOICE-RECALL.md`. Other open work: production attachments/embeds, connected pins, group DMs, presence fan-out, complete denied-route coverage, connected message virtualization, observability/load measurements and a production deployment. The personal Whisper implementation does not claim to complete those gates.

Implementation references: [OpenAI audio transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [Transformers.js speech recognition](https://huggingface.co/docs/transformers.js/api/pipelines#automaticspeechrecognitionpipeline).
