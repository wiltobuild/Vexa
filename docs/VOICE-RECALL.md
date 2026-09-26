# Vexa Recall: consent-based voice history

Status: the group-call flow below remains a design. Personal voice notes are implemented: real on-device Whisper in the demo and authenticated server-side whisper-1 in connected mode, with consent, timestamps, search, export and private retention. See [Whisper and profiles](WHISPER-AND-PROFILES.md). No group call or other participant is recorded.

## Flow

1. A server admin enables `voice_transcription` in guild feature flags (off by default).
2. Participants receive an explicit recording notice before consent. A visible recording indicator stays present for everyone. New participants must consent before their audio is forwarded. Revocation immediately stops that user's track forwarding.
3. A mediasoup PlainTransport produces consented audio into a worker. Each track retains its authenticated speaker identity. The worker mixes or transcribes tracks with timestamp offsets and never trusts client-supplied speaker IDs.
4. The worker emits namespaced `transcript.segment` and `transcript.completed` gateway dispatches, scoped to the voice channel and checked against current membership and permission rules.
5. Committed segments become searchable Postgres records. Every search/download request rechecks channel visibility and a new `VIEW_TRANSCRIPTS` permission. Never copy transcript content to an unrestricted text channel automatically.

## Storage

Proposed tables: `voice_sessions(id, guild_id, channel_id, started_at, ended_at, retention_days)`, `voice_consents(session_id,user_id,granted_at,revoked_at)`, `transcript_segments(id,session_id,speaker_id,start_ms,end_ms,text,is_final)`. Store interim text transiently; persist final text only. Raw audio retention is disabled by default. Admins set a documented retention period; users can inspect their contributions. Deletion cascades to search indexes and stored artifacts.

## Required acceptance checks

- Two authenticated browsers actually exchange audio through the SFU before transcription work begins.
- No consent means zero audio packets reach the transcription worker.
- Consent withdrawal and participant departure stop forwarding immediately.
- Speaker attribution and time ordering survive worker restart and retried jobs.
- Transcript search denies removed members and users without channel permission.
- Retention deletion removes segments and source audio, where explicitly enabled.
- Concurrent participants see recording and failure states without silently losing consent context.

This design intentionally uses server-readable text; no E2EE claim is made. Provider selection and accuracy/latency targets remain open until the working voice spike is evaluated.
