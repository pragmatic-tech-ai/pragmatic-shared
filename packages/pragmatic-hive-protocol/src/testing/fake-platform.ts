import { randomBytes } from 'node:crypto'
import { SealingKeyPair } from '../crypto/sealing-key.js'
import { SigningKeyPair, type SigningPublicKey } from '../crypto/signing-key.js'
import { EnvelopeSigner } from '../envelope/envelope-signer.js'
import { EnvelopeVerifier, KeyDirectory, type VerifiedMessage } from '../envelope/envelope-verifier.js'
import { MessageKind } from '../envelope/message-kind.js'
import { InMemoryNonceLedger } from '../envelope/nonce-ledger.js'
import { Participant, ParticipantRole } from '../envelope/participant.js'
import type { IBodyDecoder, SignedEnvelope } from '../envelope/signed-envelope.js'
import { HiveEnrolmentRequest, HiveEnrolmentResponse } from '../hive/hive-enrolment.js'
import { HiveLevel } from '../hive/hive-level.js'
import { HostEnrolmentRequest, HostEnrolmentResponse } from '../host/host-enrolment.js'
import { HostReport } from '../host/host-report.js'
import { ClusterCredentialHandover, PlacementRequest, PlacementResult } from '../host/placement.js'
import { Intent } from '../intent/intent.js'
import type { IntentAction } from '../intent/intent-action.js'
import { IntentDecision } from '../intent/intent-decision.js'
import { Pull, PullBatch } from '../intent/pull.js'
import { HiveReport } from '../report/hive-report.js'
import { ServiceAccountKeys } from '../identity/service-account-keys.js'
import { TunnelHello } from '../tunnel/tunnel.js'
import { FakeClock } from './fake-clock.js'

/** Why the fake platform turned an otherwise valid message away. */
export enum FakePlatformRefusal
{
    UnknownCode = 'The enrolment code is unknown or used.',
    CodeMismatch = 'The enrolment code was issued for another tenant, level or kind of agent.',
    UnknownIntent = 'The decision answers no intent issued to this hive.',
    UnhandledKind = 'The fake platform does not take this kind of message.',
}

export class FakePlatformRefusalError extends Error
{
    private static readonly ErrorName = 'FakePlatformRefusalError'

    public constructor(public readonly Refusal: FakePlatformRefusal)
    {
        super(Refusal)
        this.name = FakePlatformRefusalError.ErrorName
    }
}

/** A hive or host as the fake platform recorded it at enrolment (public key only). */
export class FakeAgentRecord
{
    public constructor(public readonly Participant: Participant, public readonly PublicKey: SigningPublicKey, public readonly Tenant: string | null, public readonly Level: HiveLevel | null)
    {
    }
}

/** What a one-time code was issued for. */
class FakeCode
{
    public constructor(public readonly Role: ParticipantRole, public readonly Tenant: string | null, public readonly Level: HiveLevel | null)
    {
    }
}

export interface PublishIntentOptions
{
    Level?: HiveLevel
    LifetimeMs?: number
    IntentId?: string
}

/**
 * The platform side of the agent channel, in memory: one-time codes, enrolment of hives and hosts (public keys
 * recorded), intents and placements queued per agent and served to pulls, and every verified agent message kept in
 * `Received`. It signs with its own trust root and opens sealed credentials with its own sealing key; every message it
 * takes goes through the real verifiers.
 */
export class FakePlatform
{
    public static readonly DefaultChannelUrl = 'https://edge.pragmatic.test/agent/v1'
    private static readonly HivePrefix = 'hive-'
    private static readonly HostPrefix = 'host-'
    private static readonly IntentPrefix = 'intent-'
    private static readonly CodeBytes = 24
    private static readonly Base64Url = 'base64url'

    public readonly SigningKey = SigningKeyPair.Generate()
    public readonly SealingKey = SealingKeyPair.Generate()
    public readonly Received: VerifiedMessage<unknown>[] = []
    /** Opened cluster credentials, by reference (the platform's secret store). */
    public readonly Credentials = new Map<string, Buffer>()
    public readonly Nonces: InMemoryNonceLedger
    private readonly keys = new KeyDirectory()
    private readonly codes = new Map<string, FakeCode>()
    private readonly records = new Map<string, FakeAgentRecord>()
    private readonly queues = new Map<string, SignedEnvelope[]>()
    private readonly issuedIntents = new Map<string, SignedEnvelope>()
    private readonly signer: EnvelopeSigner
    private readonly verifier: EnvelopeVerifier
    private sequence = 0

    public constructor(public readonly Clock: FakeClock = new FakeClock(), public readonly ChannelUrl: string = FakePlatform.DefaultChannelUrl)
    {
        this.Nonces = new InMemoryNonceLedger(Clock)
        this.signer = new EnvelopeSigner(this.SigningKey, Participant.Platform, Clock)
        this.verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: this.keys, Nonces: this.Nonces, Clock })
    }

    public get TrustRoot(): SigningPublicKey
    {
        return this.SigningKey.PublicKey
    }

    /** A one-time code for a hive of `tenant` at `level` (the personal cabinet's `start-enrolment`). */
    public IssueHiveCode(tenant: string, level: HiveLevel): string
    {
        return this.IssueCode(new FakeCode(ParticipantRole.Hive, tenant, level))
    }

    /** A one-time code for a hosting machine (the platform admin console). */
    public IssueHostCode(): string
    {
        return this.IssueCode(new FakeCode(ParticipantRole.Host, null, null))
    }

    public Record(participant: Participant): FakeAgentRecord | undefined
    {
        return this.records.get(participant.Key)
    }

    /** Signs an intent for `hiveId` and queues it for the hive's next pull. */
    public PublishIntent(hiveId: string, action: IntentAction, options: PublishIntentOptions = {}): SignedEnvelope
    {
        const hive = Participant.Hive(hiveId)
        const level = options.Level ?? this.records.get(hive.Key)?.Level ?? HiveLevel.Enrolled
        const intent = Intent.Create(options.IntentId ?? this.NextId(FakePlatform.IntentPrefix), level, action)
        const envelope = this.signer.Sign(MessageKind.Intent, hive, intent, options.LifetimeMs)
        this.issuedIntents.set(hive.Key + intent.IntentId, envelope)
        this.Queue(hive, envelope)
        return envelope
    }

    /** Signs a placement request for `hostId` and queues it for the host's next pull. */
    public Place(hostId: string, request: PlacementRequest, lifetimeMs?: number): SignedEnvelope
    {
        const host = Participant.Host(hostId)
        const envelope = this.signer.Sign(MessageKind.PlacementRequest, host, request, lifetimeMs)
        this.Queue(host, envelope)
        return envelope
    }

    /** The verified bodies received of one kind, oldest first. */
    public ReceivedOf<T>(kind: MessageKind): T[]
    {
        return this.Received.filter(message => message.Kind === kind).map(message => message.Body as T)
    }

    /** One agent message in, the platform's reply (or null) out. Verification failures are thrown as they are. */
    public async Handle(envelope: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        switch (envelope.Kind)
        {
            case MessageKind.HiveEnrolmentRequest:
                return this.EnrolHive(envelope)
            case MessageKind.HostEnrolmentRequest:
                return this.EnrolHost(envelope)
            case MessageKind.Pull:
                return this.AnswerPull(envelope)
            case MessageKind.IntentDecision:
                await this.TakeDecision(envelope)
                return null
            case MessageKind.HiveReport:
                await this.Take(envelope, HiveReport)
                return null
            case MessageKind.HostReport:
                await this.Take(envelope, HostReport)
                return null
            case MessageKind.PlacementResult:
                await this.Take(envelope, PlacementResult)
                return null
            case MessageKind.TunnelHello:
                await this.Take(envelope, TunnelHello)
                return null
            case MessageKind.ServiceAccountKeys:
                await this.Take(envelope, ServiceAccountKeys)
                return null
            case MessageKind.ClusterCredentialHandover:
                await this.TakeCredential(envelope)
                return null
            default:
                throw new FakePlatformRefusalError(FakePlatformRefusal.UnhandledKind)
        }
    }

    private async EnrolHive(envelope: SignedEnvelope): Promise<SignedEnvelope>
    {
        const verified = await this.verifier.VerifySelfSigned(envelope, MessageKind.HiveEnrolmentRequest, HiveEnrolmentRequest, HiveEnrolmentRequest.KeyOf)
        const request = verified.Body
        this.UseCode(request.EnrolmentCode, new FakeCode(ParticipantRole.Hive, request.Tenant, request.Level))
        const hive = Participant.Hive(this.NextId(FakePlatform.HivePrefix))
        this.Enrol(new FakeAgentRecord(hive, request.PublicKey, request.Tenant, request.Level))
        this.Received.push(verified)
        const response = HiveEnrolmentResponse.Create({ HiveId: hive.Id, Tenant: request.Tenant, Level: request.Level, TrustRoot: this.TrustRoot, ChannelUrl: this.ChannelUrl, RequestNonce: envelope.Nonce })
        return this.signer.Sign(MessageKind.HiveEnrolmentResponse, envelope.Issuer, response)
    }

    private async EnrolHost(envelope: SignedEnvelope): Promise<SignedEnvelope>
    {
        const verified = await this.verifier.VerifySelfSigned(envelope, MessageKind.HostEnrolmentRequest, HostEnrolmentRequest, HostEnrolmentRequest.KeyOf)
        this.UseCode(verified.Body.EnrolmentCode, new FakeCode(ParticipantRole.Host, null, null))
        const host = Participant.Host(this.NextId(FakePlatform.HostPrefix))
        this.Enrol(new FakeAgentRecord(host, verified.Body.PublicKey, null, null))
        this.Received.push(verified)
        const response = HostEnrolmentResponse.Create({ HostId: host.Id, TrustRoot: this.TrustRoot, SealingKey: this.SealingKey.PublicKey, ChannelUrl: this.ChannelUrl, RequestNonce: envelope.Nonce })
        return this.signer.Sign(MessageKind.HostEnrolmentResponse, envelope.Issuer, response)
    }

    private async AnswerPull(envelope: SignedEnvelope): Promise<SignedEnvelope>
    {
        const pull = (await this.verifier.Verify(envelope, MessageKind.Pull, Pull)).Body
        const queue = this.queues.get(envelope.Issuer.Key) ?? []
        const items = queue.slice(pull.After, pull.After + pull.Max)
        return this.signer.Sign(MessageKind.PullBatch, envelope.Issuer, PullBatch.Create(items, pull.After + items.length))
    }

    private async TakeDecision(envelope: SignedEnvelope): Promise<void>
    {
        const verified = await this.verifier.Verify(envelope, MessageKind.IntentDecision, IntentDecision)
        const issued = this.issuedIntents.get(envelope.Issuer.Key + verified.Body.IntentId)
        if (issued === undefined || !verified.Body.Answers(issued, Intent.Parse(issued.Body)))
        {
            throw new FakePlatformRefusalError(FakePlatformRefusal.UnknownIntent)
        }
        this.Received.push(verified)
    }

    private async TakeCredential(envelope: SignedEnvelope): Promise<void>
    {
        const verified = await this.verifier.Verify(envelope, MessageKind.ClusterCredentialHandover, ClusterCredentialHandover)
        this.Credentials.set(verified.Body.CredentialReference, verified.Body.Open(this.SealingKey, verified.Issuer))
        this.Received.push(verified)
    }

    private async Take<T>(envelope: SignedEnvelope, decoder: IBodyDecoder<T>): Promise<void>
    {
        this.Received.push(await this.verifier.Verify(envelope, envelope.Kind, decoder))
    }

    private IssueCode(code: FakeCode): string
    {
        const text = randomBytes(FakePlatform.CodeBytes).toString(FakePlatform.Base64Url)
        this.codes.set(text, code)
        return text
    }

    private UseCode(text: string, asked: FakeCode): void
    {
        const code = this.codes.get(text)
        if (code === undefined)
        {
            throw new FakePlatformRefusalError(FakePlatformRefusal.UnknownCode)
        }
        this.codes.delete(text)
        if (code.Role !== asked.Role || code.Tenant !== asked.Tenant || code.Level !== asked.Level)
        {
            throw new FakePlatformRefusalError(FakePlatformRefusal.CodeMismatch)
        }
    }

    private Enrol(record: FakeAgentRecord): void
    {
        this.records.set(record.Participant.Key, record)
        this.keys.Add(record.Participant, record.PublicKey)
    }

    private Queue(participant: Participant, envelope: SignedEnvelope): void
    {
        const queue = this.queues.get(participant.Key) ?? []
        queue.push(envelope)
        this.queues.set(participant.Key, queue)
    }

    private NextId(prefix: string): string
    {
        this.sequence += 1
        return prefix + this.sequence
    }
}
