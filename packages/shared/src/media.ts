import { z } from 'zod';
import { snowflakeSchema } from './snowflake-schema.js';

// audio-spike frozen contract (docs/tasks/audio-spike/plan.md, "Builder
// track split" -> "Frozen contract"). Approved after 3 rounds of
// independent review. Do not change without updating both builder tracks.

// --- shared mediasoup-shaped sub-schemas ---
// These mirror mediasoup/mediasoup-client's own TS types closely enough to
// bound size/shape for parsing and DoS rejection; mediasoup's own runtime
// (transport.connect/produce/consume) performs the authoritative structural
// validation of these payloads -- Zod's job here is "reject garbage early
// and pin the wire shape for Track B," not reimplement mediasoup's own checks.
const rtpCodecCapabilitySchema = z.object({
  kind: z.literal('audio'),
  mimeType: z.string().max(64),
  clockRate: z.number().int().positive(),
  channels: z.number().int().positive().optional(),
  preferredPayloadType: z.number().int().optional(),
  parameters: z.record(z.union([z.string(), z.number()])).optional(),
  rtcpFeedback: z.array(z.object({ type: z.string(), parameter: z.string().optional() })).optional(),
}).passthrough();
const rtpHeaderExtensionSchema = z.object({
  kind: z.literal('audio'),
  uri: z.string(),
  preferredId: z.number().int(),
  preferredEncrypt: z.boolean().optional(),
  direction: z.string().optional(),
}).passthrough();
export const rtpCapabilitiesSchema = z.object({
  codecs: z.array(rtpCodecCapabilitySchema).max(16),
  headerExtensions: z.array(rtpHeaderExtensionSchema).max(16).optional(),
}).passthrough();
const dtlsFingerprintSchema = z.object({ algorithm: z.string(), value: z.string() });
export const dtlsParametersSchema = z.object({
  role: z.enum(['auto', 'client', 'server']).optional(),
  fingerprints: z.array(dtlsFingerprintSchema).min(1).max(8),
});
// mediasoup's real `RtpParameters` type (used for produce/consume payloads)
// is NOT the same shape as `RtpCapabilities` (used for
// rtpCapabilitiesSchema/rtpCodecCapabilitySchema above): a capabilities
// codec entry describes what a device *can* do; a parameters codec entry
// describes what a specific producer/consumer *is actually sending*, and
// does not carry a `kind` field at all -- `kind` lives one level up, on the
// `produce` request payload itself (payload.kind in mediaRequestSchema
// below), not inside each codec. Track A should still confirm field-for-
// field against the installed mediasoup/mediasoup-client type definitions
// as its first smoke check before writing signaling logic, since this is
// exactly the kind of thing that silently breaks between minor versions.
const rtpParametersCodecSchema = z.object({
  mimeType: z.string().max(64),
  payloadType: z.number().int(),
  clockRate: z.number().int().positive(),
  channels: z.number().int().positive().optional(),
  parameters: z.record(z.union([z.string(), z.number()])).optional(),
  rtcpFeedback: z.array(z.object({ type: z.string(), parameter: z.string().optional() })).optional(),
}).passthrough();
export const rtpParametersSchema = z.object({
  mid: z.string().optional(),
  codecs: z.array(rtpParametersCodecSchema).min(1).max(4),
  headerExtensions: z.array(z.object({
    uri: z.string(),
    id: z.number().int(),
    encrypt: z.boolean().optional(),
    parameters: z.record(z.union([z.string(), z.number()])).optional(),
  })).max(16).optional(),
  encodings: z.array(z.object({
    ssrc: z.number().int().optional(),
    rid: z.string().optional(),
    codecPayloadType: z.number().int().optional(),
    dtx: z.boolean().optional(),
    scalabilityMode: z.string().optional(),
  })).max(4).optional(),
  rtcp: z.object({ cname: z.string().optional(), reducedSize: z.boolean().optional() }).optional(),
}).passthrough();

// --- envelope ---
export const mediaRequestSchema = z.discriminatedUnion('type', [
  z.object({ reqId: z.string().uuid(), type: z.literal('join'), payload: z.object({ channelId: snowflakeSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('createTransport'), payload: z.object({ direction: z.enum(['send', 'recv']) }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('connectTransport'), payload: z.object({ transportId: z.string().uuid(), dtlsParameters: dtlsParametersSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('produce'), payload: z.object({ transportId: z.string().uuid(), kind: z.literal('audio'), rtpParameters: rtpParametersSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('consume'), payload: z.object({ transportId: z.string().uuid(), producerId: z.string().uuid(), rtpCapabilities: rtpCapabilitiesSchema }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('resumeConsumer'), payload: z.object({ consumerId: z.string().uuid() }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('leave'), payload: z.object({}) }),
  // device-network-handling addition: a client whose transport's ICE
  // connection state goes 'disconnected'/'failed' (e.g. a network change)
  // requests fresh ICE parameters for that transport rather than tearing
  // the whole call down. Ownership: resolved via the requesting peer's own
  // transports map, same tier-1 rule as connectTransport/produce/consume.
  z.object({ reqId: z.string().uuid(), type: z.literal('restartIce'), payload: z.object({ transportId: z.string().uuid() }) }),
  // participant-limits-and-moderation addition: guild MODERATE_MEMBERS only
  // (checked via requireGuild against the target channel's guild_id, not
  // the tier-1 per-peer ownership rule the ops above use -- a moderator
  // acts on ANOTHER peer's connection, which is exactly what tier-1
  // ownership exists to prevent for everyone else). The server resolves
  // targetUserId to a connected Peer within that channel's room; unknown
  // target -> 404, same error shape as every other "doesn't exist" case in
  // this contract.
  z.object({ reqId: z.string().uuid(), type: z.literal('moderatorSetMute'), payload: z.object({ channelId: snowflakeSchema, targetUserId: snowflakeSchema, muted: z.boolean() }) }),
  z.object({ reqId: z.string().uuid(), type: z.literal('moderatorDisconnect'), payload: z.object({ channelId: snowflakeSchema, targetUserId: snowflakeSchema }) }),
]);
export type MediaRequest = z.infer<typeof mediaRequestSchema>;

// --- response data per request type (all wrapped as
// {reqId, ok:true, data} | {reqId, ok:false, error:{code,message}}) ---
export const joinResponseSchema = z.object({
  rtpCapabilities: rtpCapabilitiesSchema,
  existingProducers: z.array(z.object({ producerId: z.string().uuid(), userId: snowflakeSchema, kind: z.literal('audio') })),
});
export const createTransportResponseSchema = z.object({
  transportId: z.string().uuid(),
  iceParameters: z.object({ usernameFragment: z.string(), password: z.string(), iceLite: z.boolean().optional() }),
  // mediasoup's actual `IceCandidate` type uses `address`, not `ip`.
  iceCandidates: z.array(z.object({ foundation: z.string(), priority: z.number(), address: z.string(), protocol: z.enum(['udp', 'tcp']), port: z.number(), type: z.literal('host'), tcpType: z.string().optional() })),
  dtlsParameters: dtlsParametersSchema,
});
export const connectTransportResponseSchema = z.object({});
export const produceResponseSchema = z.object({ producerId: z.string().uuid() });
export const consumeResponseSchema = z.object({
  consumerId: z.string().uuid(),
  producerId: z.string().uuid(),
  kind: z.literal('audio'),
  rtpParameters: rtpParametersSchema,
});
export const resumeConsumerResponseSchema = z.object({});
export const leaveResponseSchema = z.object({});
// mediasoup's WebRtcTransport#restartIce() returns fresh iceParameters only
// (candidates/dtlsParameters are unchanged by an ICE restart) -- the client
// applies these via mediasoup-client's Transport#restartIce({iceParameters}).
export const restartIceResponseSchema = z.object({
  iceParameters: z.object({ usernameFragment: z.string(), password: z.string(), iceLite: z.boolean().optional() }),
});
export const moderatorSetMuteResponseSchema = z.object({});
export const moderatorDisconnectResponseSchema = z.object({});

export const mediaResponseSchema = z.discriminatedUnion('ok', [
  z.object({ reqId: z.string().uuid(), ok: z.literal(true), data: z.unknown() }),
  z.object({ reqId: z.string().uuid(), ok: z.literal(false), error: z.object({ code: z.number().int(), message: z.string() }) }),
]);
export type MediaResponse = z.infer<typeof mediaResponseSchema>;

// --- server-initiated events (no reqId) ---
export const mediaEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('peerJoined'), payload: z.object({ userId: snowflakeSchema }) }),
  z.object({ type: z.literal('peerLeft'), payload: z.object({ userId: snowflakeSchema }) }),
  z.object({ type: z.literal('newProducer'), payload: z.object({ producerId: z.string().uuid(), userId: snowflakeSchema, kind: z.literal('audio') }) }),
  z.object({ type: z.literal('producerClosed'), payload: z.object({ producerId: z.string().uuid() }) }),
  // device-network-handling addition: sent to every connected peer once,
  // before the server begins graceful shutdown (SIGTERM/SIGINT), so clients
  // can show a clear "server restarting" state and attempt reconnection
  // instead of seeing an unexplained abrupt close.
  z.object({ type: z.literal('serverShuttingDown'), payload: z.object({}) }),
  // participant-limits-and-moderation addition: broadcast to every peer in
  // the room (including the muted participant themselves, who uses this to
  // lock their own mute toggle rather than a separate targeted event --
  // simpler than adding a second event type for the same fact). Only
  // covers moderator-initiated mutes in this pass; self-mute stays a
  // purely client-side producer.pause() with no server round-trip, as it
  // already was before this addition -- reconciling self-mute broadcast to
  // other participants is explicitly out of scope (see plan.md).
  z.object({ type: z.literal('participantMuted'), payload: z.object({ userId: snowflakeSchema, muted: z.boolean() }) }),
  // Sent only to the removed peer's own socket, immediately before the
  // server closes it -- lets the client show "removed by a moderator"
  // instead of a generic connection-lost state. Everyone else in the room
  // still gets the existing peerLeft broadcast.
  z.object({ type: z.literal('removedByModerator'), payload: z.object({}) }),
]);
export type MediaEvent = z.infer<typeof mediaEventSchema>;

// Malformed-request rule (frozen contract): a message that fails to parse
// against mediaRequestSchema at all (bad JSON, unknown `type`, envelope
// shape violation) closes the socket with WS close code 4002. A message
// that parses but fails at the operation level (e.g. requireChannel denial,
// unknown transport/producer id, channel not type 'voice') replies
// {reqId, ok:false, error:{code,message}} and keeps the connection open.
export const MALFORMED_REQUEST_CLOSE_CODE = 4002;

// Consumer create-then-resume sequence: mediasoup requires consumers to be
// created **paused** on the server (router.canConsume check, then
// transport.consume({..., paused: true})) so the client has a chance to set
// up its <audio>/MediaStreamTrack before RTP starts flowing. Sequence:
// client sends `consume` -> server creates the paused Consumer, responds
// with consumeResponseSchema data -> client attaches the track locally ->
// client sends `resumeConsumer` -> server calls consumer.resume(), responds
// resumeConsumerResponseSchema (empty data) -> RTP starts arriving.
// Skipping the resumeConsumer step leaves the consumer permanently paused.
