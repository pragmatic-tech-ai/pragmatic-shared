import type { IAgentChannel } from '../channel/agent-channel.js'
import { EnrolmentHandshake } from '../channel/enrolment-handshake.js'
import type { SealingPublicKey } from '../crypto/sealing-key.js'
import { SigningKeyPair, type SigningPublicKey } from '../crypto/signing-key.js'
import { EnvelopeSigner } from '../envelope/envelope-signer.js'
import { EnvelopeVerifier, KeyDirectory, type VerifiedMessage } from '../envelope/envelope-verifier.js'
import { MessageKind } from '../envelope/message-kind.js'
import { InMemoryNonceLedger } from '../envelope/nonce-ledger.js'
import { Participant, ParticipantRole } from '../envelope/participant.js'
import type { IProtocolClock } from '../envelope/protocol-clock.js'
import type { IBodyDecoder, IMessageBody, SignedEnvelope } from '../envelope/signed-envelope.js'
import { ConsoleAddress } from '../hive/console-address.js'
import { HiveEnrolmentRequest, type HiveEnrolmentResponse } from '../hive/hive-enrolment.js'
import { HiveLevel } from '../hive/hive-level.js'
import { ClusterKind, HostEnrolmentRequest, type HostEnrolmentResponse } from '../host/host-enrolment.js'
import type { HostReport } from '../host/host-report.js'
import { ClusterCredentialHandover, PlacementRequest, type PlacementResult } from '../host/placement.js'
import { Intent, IntentAdmission, type IntentApplyMode } from '../intent/intent.js'
import { IntentDecision, type IntentDecisionKind, type RealmSubject } from '../intent/intent-decision.js'
import { Pull, PullBatch } from '../intent/pull.js'
import type { HiveReport } from '../report/hive-report.js'
import type { ServiceAccountKeys } from '../identity/service-account-keys.js'
import { TunnelHello } from '../tunnel/tunnel.js'

/** An agent call that needs enrolment first. */
export class FakeAgentNotEnrolledError extends Error
{
    private static readonly ErrorName = 'FakeAgentNotEnrolledError'
    private static readonly Text = 'The agent is not enrolled.'

    public constructor()
    {
        super(FakeAgentNotEnrolledError.Text)
        this.name = FakeAgentNotEnrolledError.ErrorName
    }
}

/** The platform acknowledged where the agent expected a reply. */
export class FakeAgentNoReplyError extends Error
{
    private static readonly ErrorName = 'FakeAgentNoReplyError'
    private static readonly Text = 'The platform sent no reply where one was expected.'

    public constructor()
    {
        super(FakeAgentNoReplyError.Text)
        this.name = FakeAgentNoReplyError.ErrorName
    }
}

/**
 * What a hive agent and a host agent share: an Ed25519 key generated at start, self-signed until enrolled, then a
 * participant id and the adopted trust root; pulls verified batch by batch and item by item; a signed tunnel hello.
 */
export abstract class FakeAgent
{
    public static readonly DefaultVersion = '0.10.0'
    public readonly Key = SigningKeyPair.Generate()
    public readonly Nonces: InMemoryNonceLedger
    protected signer: EnvelopeSigner
    protected verifier: EnvelopeVerifier | undefined
    private cursor = 0

    protected constructor(protected readonly channel: IAgentChannel, protected readonly clock: IProtocolClock, private readonly role: ParticipantRole.Hive | ParticipantRole.Host, protected readonly pinnedTrustRoot: SigningPublicKey | undefined)
    {
        this.Nonces = new InMemoryNonceLedger(clock)
        this.signer = EnvelopeSigner.SelfSigned(this.Key, role, clock)
    }

    /** Who the agent signs as: its key id before enrolment, its id after. */
    public get Self(): Participant
    {
        return this.signer.Issuer
    }

    public get Enrolled(): boolean
    {
        return this.verifier !== undefined
    }

    public async Hello(names: readonly string[]): Promise<void>
    {
        await this.Send(MessageKind.TunnelHello, TunnelHello.Create(names, FakeAgent.DefaultVersion))
    }

    protected Handshake(): EnrolmentHandshake
    {
        return new EnrolmentHandshake({ Clock: this.clock, Nonces: this.Nonces, PinnedTrustRoot: this.pinnedTrustRoot })
    }

    protected async SendSelfSigned(kind: MessageKind, body: IMessageBody): Promise<{ Request: SignedEnvelope, Response: SignedEnvelope }>
    {
        const request = this.signer.Sign(kind, Participant.Platform, body)
        const response = await this.channel.Exchange(request)
        if (response === null)
        {
            throw new FakeAgentNoReplyError()
        }
        return { Request: request, Response: response }
    }

    protected Adopt(id: string, trustRoot: SigningPublicKey): void
    {
        const self = Participant.Of(this.role, id)
        this.signer = new EnvelopeSigner(this.Key, self, this.clock)
        this.verifier = new EnvelopeVerifier({ Self: self, Keys: new KeyDirectory().Add(Participant.Platform, trustRoot), Nonces: this.Nonces, Clock: this.clock })
    }

    /** The agent's verifier for platform messages (after enrolment). */
    public Verifier(): EnvelopeVerifier
    {
        if (this.verifier === undefined)
        {
            throw new FakeAgentNotEnrolledError()
        }
        return this.verifier
    }

    /** Signs and sends any agent message (tests use it to send what a well-behaved agent would not). */
    public async Send(kind: MessageKind, body: IMessageBody): Promise<SignedEnvelope | null>
    {
        this.Verifier()
        return this.channel.Exchange(this.signer.Sign(kind, Participant.Platform, body))
    }

    /** Pulls after the cursor; verifies the batch, then each item as `kind`; moves the cursor. */
    protected async PullItems<T>(kind: MessageKind, decoder: IBodyDecoder<T>): Promise<VerifiedMessage<T>[]>
    {
        const reply = await this.Send(MessageKind.Pull, Pull.Create(this.cursor))
        if (reply === null)
        {
            throw new FakeAgentNoReplyError()
        }
        const batch = await this.Verifier().Verify(reply, MessageKind.PullBatch, PullBatch)
        const items: VerifiedMessage<T>[] = []
        for (const item of batch.Body.Items)
        {
            items.push(await this.Verifier().Verify(item, kind, decoder))
        }
        this.cursor = batch.Body.Cursor
        return items
    }
}

/** A hive agent in memory: enrols with a code, pulls and verifies intents, decides, reports. */
export class FakeHiveAgent extends FakeAgent
{
    public Level: HiveLevel = HiveLevel.Enrolled
    public Enrolment: HiveEnrolmentResponse | undefined

    public constructor(channel: IAgentChannel, clock: IProtocolClock, pinnedTrustRoot?: SigningPublicKey)
    {
        super(channel, clock, ParticipantRole.Hive, pinnedTrustRoot)
    }

    public async Enrol(code: string, tenant: string, level: HiveLevel, consoleAddress: ConsoleAddress = ConsoleAddress.RelayedHiveSubdomain(tenant)): Promise<HiveEnrolmentResponse>
    {
        const body = HiveEnrolmentRequest.Create({ EnrolmentCode: code, Tenant: tenant, Level: level, PublicKey: this.Key.PublicKey, EngineVersion: FakeAgent.DefaultVersion, ConsoleAddress: consoleAddress })
        const exchange = await this.SendSelfSigned(MessageKind.HiveEnrolmentRequest, body)
        const verified = await this.Handshake().AcceptHive(exchange.Response, exchange.Request)
        this.Adopt(verified.Body.HiveId, verified.Body.TrustRoot)
        this.Level = verified.Body.Level
        this.Enrolment = verified.Body
        return verified.Body
    }

    public async PullIntents(): Promise<VerifiedMessage<Intent>[]>
    {
        return this.PullItems(MessageKind.Intent, Intent)
    }

    public ModeFor(intent: VerifiedMessage<Intent>): IntentApplyMode
    {
        return new IntentAdmission(this.Level).ModeFor(intent.Body)
    }

    /** Rechecks the kept intent (signature, expiry), then sends the decision on it. */
    public async Decide(intent: VerifiedMessage<Intent>, decision: IntentDecisionKind, approver: RealmSubject): Promise<void>
    {
        const current = await this.Verifier().Recheck(intent.Envelope, MessageKind.Intent, Intent)
        await this.Send(MessageKind.IntentDecision, IntentDecision.For(current, decision, approver, this.clock.Now()))
    }

    public async Report(report: HiveReport): Promise<void>
    {
        await this.Send(MessageKind.HiveReport, report)
    }

    /** Tells the platform its cluster's service-account issuer and public keys. */
    public async ReportServiceAccountKeys(keys: ServiceAccountKeys): Promise<void>
    {
        await this.Send(MessageKind.ServiceAccountKeys, keys)
    }
}

/** A host agent in memory: enrols with a code, pulls placements, reports capacity, hands over sealed credentials. */
export class FakeHostAgent extends FakeAgent
{
    public static readonly DefaultMeshAddress = 'hive-laptop.mesh.pragmatic.test'
    public Enrolment: HostEnrolmentResponse | undefined

    public constructor(channel: IAgentChannel, clock: IProtocolClock, pinnedTrustRoot?: SigningPublicKey)
    {
        super(channel, clock, ParticipantRole.Host, pinnedTrustRoot)
    }

    public get SealingKey(): SealingPublicKey
    {
        if (this.Enrolment === undefined)
        {
            throw new FakeAgentNotEnrolledError()
        }
        return this.Enrolment.SealingKey
    }

    public async Enrol(code: string, machineName: string, clusterKind: ClusterKind = ClusterKind.K3s, meshAddress: string = FakeHostAgent.DefaultMeshAddress): Promise<HostEnrolmentResponse>
    {
        const body = HostEnrolmentRequest.Create({ EnrolmentCode: code, MachineName: machineName, PublicKey: this.Key.PublicKey, ClusterKind: clusterKind, AgentVersion: FakeAgent.DefaultVersion, MeshAddress: meshAddress })
        const exchange = await this.SendSelfSigned(MessageKind.HostEnrolmentRequest, body)
        const verified = await this.Handshake().AcceptHost(exchange.Response, exchange.Request)
        this.Adopt(verified.Body.HostId, verified.Body.TrustRoot)
        this.Enrolment = verified.Body
        return verified.Body
    }

    public async PullPlacements(): Promise<VerifiedMessage<PlacementRequest>[]>
    {
        return this.PullItems(MessageKind.PlacementRequest, PlacementRequest)
    }

    public async Report(report: HostReport): Promise<void>
    {
        await this.Send(MessageKind.HostReport, report)
    }

    public async Result(result: PlacementResult): Promise<void>
    {
        await this.Send(MessageKind.PlacementResult, result)
    }

    public async HandOver(placementId: string, rotation: number, credential: Buffer, expiresAt: Date): Promise<void>
    {
        const handover = ClusterCredentialHandover.Create({ Host: this.Self, PlacementId: placementId, Rotation: rotation, ExpiresAt: expiresAt, Credential: credential, SealingKey: this.SealingKey })
        await this.Send(MessageKind.ClusterCredentialHandover, handover)
    }
}
