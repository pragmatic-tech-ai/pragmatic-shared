# @pragmatic-tech-ai/pragmatic-hive-protocol

The agent channel's messages and their verification, shared by the hive agent, the host agent, the platform edge and
the platform admin console (hive management levels design §4-§7; stage C design, Ledger "pragmatic-hive-protocol").
No dependencies beyond `node:crypto`.

- **Envelope.** Every message is a `SignedEnvelope`: kind, issuer, audience, key id, issued-at, expires-at, nonce,
  body and an Ed25519 signature over the canonical JSON of the rest (domain-separated). `EnvelopeSigner` signs as one
  `Participant` (platform, hive, host); `EnvelopeVerifier` checks kind, the issuer role allowed for the kind, audience,
  key, signature, freshness (`FreshnessPolicy`: minutes for exchanges, up to 30 days for standing intents and
  placements, two minutes of skew) and the nonce (`INonceLedger`), then decodes the body strictly.
- **Codecs.** Every shape is closed (`StrictFields.Exactly`: unknown members refused, every member present), every
  string pattern- and length-bound, every state an enum; errors name a path and a fixed reason, never a value.
- **Hive identity and enrolment.** `SigningKeyPair` (generated in the cluster, private half never leaves it),
  `HiveEnrolmentRequest` (code, tenant, level, public key, engine version, `ConsoleAddress`), self-signed;
  `HiveEnrolmentResponse` (hive id, trust root, channel URL, answered nonce); `EnrolmentHandshake` on the agent side.
- **Intents.** `Intent` (id, level, `IntentAction`: component-at-version, create/update/delete environment, rotate,
  repair) signed by the platform; `IntentAdmission` (applies directly only when both the hive and the intent are Delegated, otherwise waits for approval);
  `IntentDecision` signed by the hive key, naming the approving `RealmSubject` and the intent's digest; `Pull` /
  `PullBatch`.
- **Reports.** `HiveReport`: component states, per-environment name/readiness/version, intent progress; nothing else
  fits.
- **Host agent.** `HostEnrolmentRequest`/`Response` (with the platform's X25519 sealing key), `HostReport`,
  `PlacementRequest`, `PlacementResult` (credential reference only), `ClusterCredentialHandover` (the credential as
  a `SealedBlob` for the platform's sealing key).
- **Tunnel control.** `TunnelHello` (signed, SNI names) and the unsigned `TunnelFrames` (ready, open-stream,
  stream-opened, close-stream). The data plane is the implementation's.
- **Transport.** `AgentExchangeLink` (the edge's `POST /agent/v2/exchange`, 1 MiB, 200 envelope / 204 / refusal
  `{ error, code }` with an `AgentExchangeRefusal` code) and `HttpAgentChannel` (the agent's `IAgentChannel` over
  `fetch`, 30-second deadline, `AgentChannelUnavailableError` with status and code). `AgentInternalLink`,
  `HiveEnrolmentCall`, `HiveEnrolmentStatus`, `HiveEnrolmentRefusal`: the hive agent's cluster-internal enrolment API
  the engine's console calls (port 7210, TokenReview audience `pragmatic-hive-agent`).
- **Testing** (`./testing`): `FakeClock`, `FakePlatform`, `FakeAgentChannel`, `FakeHiveAgent`, `FakeHostAgent`.
