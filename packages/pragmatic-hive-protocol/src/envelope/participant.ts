import { ProtocolNames } from '../wire/protocol-names.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { StrictFields } from '../wire/strict-fields.js'

/** Who signs or receives a message. The platform edge and admin console speak as the one platform. */
export enum ParticipantRole
{
    Platform = 'platform',
    Hive = 'hive',
    Host = 'host',
}

export interface ParticipantJson
{
    Role: ParticipantRole
    Id: string
}

/**
 * One party on the agent channel: the platform, a hive (by its hive id, or by its key id before enrolment) or a host
 * agent (likewise). An envelope names its issuer and its audience as participants.
 */
export class Participant
{
    public static readonly PlatformId = 'platform'
    public static readonly Roles: readonly ParticipantRole[] = Object.values(ParticipantRole)
    private static readonly Field = { Role: 'Role', Id: 'Id' } as const
    private static readonly Members: readonly string[] = Object.values(Participant.Field)
    private static readonly KeySeparator = '/'
    private static readonly MaxId = 63

    private constructor(public readonly Role: ParticipantRole, public readonly Id: string)
    {
    }

    public static readonly Platform = new Participant(ParticipantRole.Platform, Participant.PlatformId)

    public static Hive(id: string): Participant
    {
        return Participant.Of(ParticipantRole.Hive, id)
    }

    public static Host(id: string): Participant
    {
        return Participant.Of(ParticipantRole.Host, id)
    }

    public static Of(role: ParticipantRole, id: string): Participant
    {
        return Participant.Parse({ Role: role, Id: id })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): Participant
    {
        const F = Participant.Field
        const fields = StrictFields.Exactly(value, Participant.Members, path)
        const role = fields.Enum(F.Role, Participant.Roles)
        const id = fields.String(F.Id, { Max: Participant.MaxId, Pattern: ProtocolNames.Label })
        if (role === ParticipantRole.Platform && id !== Participant.PlatformId)
        {
            throw fields.Refuse(F.Id, DecodeReason.NotAllowed)
        }
        return new Participant(role, id)
    }

    /** One string per participant, for maps and nonce scopes. */
    public get Key(): string
    {
        return this.Role + Participant.KeySeparator + this.Id
    }

    public Equals(other: Participant): boolean
    {
        return this.Role === other.Role && this.Id === other.Id
    }

    public ToJson(): ParticipantJson
    {
        return { Role: this.Role, Id: this.Id }
    }
}
