import { ParticipantRole } from './participant.js'

/** Every message on the agent channel, by what it is and who sends it. */
export enum MessageKind
{
    HiveEnrolmentRequest = 'hive.enrolment-request',
    HiveEnrolmentResponse = 'platform.hive-enrolment-response',
    Pull = 'agent.pull',
    PullBatch = 'platform.pull-batch',
    Intent = 'platform.intent',
    IntentDecision = 'hive.intent-decision',
    HiveReport = 'hive.report',
    HostEnrolmentRequest = 'host.enrolment-request',
    HostEnrolmentResponse = 'platform.host-enrolment-response',
    HostReport = 'host.capacity-report',
    PlacementRequest = 'platform.placement-request',
    PlacementResult = 'host.placement-result',
    ClusterCredentialHandover = 'host.cluster-credential',
    TunnelHello = 'agent.tunnel-hello',
    ServiceAccountKeys = 'hive.service-account-keys',
    HiveKeyRotation = 'hive.key-rotation',
    HiveKeyRotationAck = 'platform.hive-key-rotation-ack',
}

/** How long a kind of message may be valid, and how much clock skew between the two parties is tolerated. */
export class FreshnessPolicy
{
    private static readonly Minute = 60_000
    private static readonly Day = 86_400_000

    /** Requests and replies: a few minutes, so a captured message is useless soon after. */
    public static readonly Exchange = new FreshnessPolicy(5 * FreshnessPolicy.Minute, 2 * FreshnessPolicy.Minute, 2 * FreshnessPolicy.Minute)
    /** Standing orders (intents, placements): they may wait for an approval, so days; the issuer picks the expiry. */
    public static readonly Standing = new FreshnessPolicy(30 * FreshnessPolicy.Day, 7 * FreshnessPolicy.Day, 2 * FreshnessPolicy.Minute)

    private constructor(public readonly MaxLifetimeMs: number, public readonly DefaultLifetimeMs: number, public readonly MaxSkewMs: number)
    {
    }
}

/** What one kind allows: who may sign it, who it is addressed to, whether its issuer key is in the body, its freshness. */
export class MessageKindRule
{
    public constructor(
        public readonly Issuers: readonly ParticipantRole[],
        public readonly Audiences: readonly ParticipantRole[],
        public readonly SelfSigned: boolean,
        public readonly Freshness: FreshnessPolicy)
    {
    }
}

/** The kind table: the one place that says which party signs which message. */
export class MessageKinds
{
    public static readonly All: readonly MessageKind[] = Object.values(MessageKind)
    private static readonly Agents: readonly ParticipantRole[] = [ParticipantRole.Hive, ParticipantRole.Host]
    private static readonly Platform: readonly ParticipantRole[] = [ParticipantRole.Platform]
    private static readonly Hive: readonly ParticipantRole[] = [ParticipantRole.Hive]
    private static readonly Host: readonly ParticipantRole[] = [ParticipantRole.Host]
    private static readonly Rules: ReadonlyMap<MessageKind, MessageKindRule> = new Map([
        [MessageKind.HiveEnrolmentRequest, new MessageKindRule(MessageKinds.Hive, MessageKinds.Platform, true, FreshnessPolicy.Exchange)],
        [MessageKind.HiveEnrolmentResponse, new MessageKindRule(MessageKinds.Platform, MessageKinds.Hive, false, FreshnessPolicy.Exchange)],
        [MessageKind.Pull, new MessageKindRule(MessageKinds.Agents, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.PullBatch, new MessageKindRule(MessageKinds.Platform, MessageKinds.Agents, false, FreshnessPolicy.Exchange)],
        [MessageKind.Intent, new MessageKindRule(MessageKinds.Platform, MessageKinds.Hive, false, FreshnessPolicy.Standing)],
        [MessageKind.IntentDecision, new MessageKindRule(MessageKinds.Hive, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.HiveReport, new MessageKindRule(MessageKinds.Hive, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.HostEnrolmentRequest, new MessageKindRule(MessageKinds.Host, MessageKinds.Platform, true, FreshnessPolicy.Exchange)],
        [MessageKind.HostEnrolmentResponse, new MessageKindRule(MessageKinds.Platform, MessageKinds.Host, false, FreshnessPolicy.Exchange)],
        [MessageKind.HostReport, new MessageKindRule(MessageKinds.Host, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.PlacementRequest, new MessageKindRule(MessageKinds.Platform, MessageKinds.Host, false, FreshnessPolicy.Standing)],
        [MessageKind.PlacementResult, new MessageKindRule(MessageKinds.Host, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.ClusterCredentialHandover, new MessageKindRule(MessageKinds.Host, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.TunnelHello, new MessageKindRule(MessageKinds.Agents, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.ServiceAccountKeys, new MessageKindRule(MessageKinds.Hive, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.HiveKeyRotation, new MessageKindRule(MessageKinds.Hive, MessageKinds.Platform, false, FreshnessPolicy.Exchange)],
        [MessageKind.HiveKeyRotationAck, new MessageKindRule(MessageKinds.Platform, MessageKinds.Hive, false, FreshnessPolicy.Exchange)],
    ])

    public static Rule(kind: MessageKind): MessageKindRule
    {
        return MessageKinds.Rules.get(kind) as MessageKindRule
    }
}
