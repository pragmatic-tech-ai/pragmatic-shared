import { DecodeReason, ProtocolDecodeError } from '../wire/protocol-decode-error.js'
import { ProtocolJson } from '../wire/protocol-json.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'
import { ConsoleAddress } from '../hive/console-address.js'

/**
 * The first message on an agent's outbound tunnel to the edge (`MessageKind.TunnelHello`, signed by the hive or host
 * key): the SNI names it serves (each one label under `hives.pragmatic-tech.ai`). The edge accepts only names the
 * platform's records give that agent and answers with a `TunnelReady` frame listing them.
 */
export class TunnelHello
{
    public static readonly MaxNames = 64
    private static readonly Field = { Names: 'Names', AgentVersion: 'AgentVersion' } as const
    private static readonly Members: readonly string[] = Object.values(TunnelHello.Field)

    private constructor(public readonly Names: readonly string[], public readonly AgentVersion: string)
    {
    }

    public static Create(names: readonly string[], agentVersion: string): TunnelHello
    {
        return TunnelHello.Parse({ Names: [...names], AgentVersion: agentVersion })
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): TunnelHello
    {
        const F = TunnelHello.Field
        const fields = StrictFields.Exactly(value, TunnelHello.Members, path)
        return new TunnelHello(TunnelNames.Read(fields, F.Names, 1), fields.String(F.AgentVersion, { Pattern: ProtocolNames.Version }))
    }

    public ToJson(): { Names: string[], AgentVersion: string }
    {
        return { Names: [...this.Names], AgentVersion: this.AgentVersion }
    }
}

/** The SNI name lists tunnel messages carry. */
export class TunnelNames
{
    public static Read(fields: StrictFields, name: string, min: number): string[]
    {
        const names = fields.UniqueArray(name, TunnelHello.MaxNames, (raw, at) => TunnelNames.One(raw, at), entry => entry)
        if (names.length < min)
        {
            throw fields.Refuse(name, DecodeReason.Missing)
        }
        return names
    }

    public static One(value: unknown, path: string): string
    {
        const sni = StrictFields.StringAt(value, path, { Max: 253, Pattern: ProtocolNames.HostName })
        if (!ConsoleAddress.IsHiveSubdomain(sni))
        {
            throw new ProtocolDecodeError(path, DecodeReason.BadFormat)
        }
        return sni
    }
}

/** The members tunnel frames share. */
export class TunnelFields
{
    public static readonly Frame = 'Frame'
    public static readonly StreamId = 'StreamId'
    public static readonly MaxStreamId = 2_147_483_647

    public static ReadStreamId(fields: StrictFields): number
    {
        return fields.Integer(TunnelFields.StreamId, { Min: 1, Max: TunnelFields.MaxStreamId })
    }
}

/** The control frames inside an established tunnel. */
export enum TunnelFrameKind
{
    /** Edge → agent: the names the edge will relay to this tunnel. */
    Ready = 'ready',
    /** Edge → agent: a client connected for this SNI name; the TLS bytes follow on the stream. */
    OpenStream = 'open-stream',
    /** Agent → edge: the stream is connected to the hive's ingress. */
    StreamOpened = 'stream-opened',
    /** Either side: the stream is over. */
    CloseStream = 'close-stream',
}

/** Why a stream closed: a fixed set, no text. */
export enum StreamCloseReason
{
    Done = 'done',
    Refused = 'refused',
    UnknownName = 'unknown-name',
    Capacity = 'capacity',
    Idle = 'idle',
    Error = 'error',
}

/** Edge → agent: the accepted names. */
export class TunnelReady
{
    public readonly Frame = TunnelFrameKind.Ready
    public static readonly Members: readonly string[] = [TunnelFields.Frame, 'Names']

    public constructor(public readonly Names: readonly string[])
    {
    }

    public static Read(fields: StrictFields): TunnelReady
    {
        return new TunnelReady(TunnelNames.Read(fields, TunnelReady.Members[1] as string, 0))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Frame: this.Frame, Names: [...this.Names] }
    }
}

/** Edge → agent: open stream `StreamId` for a client that asked for SNI `Name`. No client address travels. */
export class OpenStream
{
    public readonly Frame = TunnelFrameKind.OpenStream
    public static readonly Members: readonly string[] = [TunnelFields.Frame, TunnelFields.StreamId, 'Name']

    public constructor(public readonly StreamId: number, public readonly Name: string)
    {
    }

    public static Read(fields: StrictFields): OpenStream
    {
        return new OpenStream(TunnelFields.ReadStreamId(fields), fields.Read(OpenStream.Members[2] as string, (raw, at) => TunnelNames.One(raw, at)))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Frame: this.Frame, StreamId: this.StreamId, Name: this.Name }
    }
}

/** Agent → edge: stream `StreamId` is connected. */
export class StreamOpened
{
    public readonly Frame = TunnelFrameKind.StreamOpened
    public static readonly Members: readonly string[] = [TunnelFields.Frame, TunnelFields.StreamId]

    public constructor(public readonly StreamId: number)
    {
    }

    public static Read(fields: StrictFields): StreamOpened
    {
        return new StreamOpened(TunnelFields.ReadStreamId(fields))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Frame: this.Frame, StreamId: this.StreamId }
    }
}

/** Either side: stream `StreamId` is closed, for a coded reason. */
export class CloseStream
{
    public readonly Frame = TunnelFrameKind.CloseStream
    public static readonly Reasons: readonly StreamCloseReason[] = Object.values(StreamCloseReason)
    public static readonly Members: readonly string[] = [TunnelFields.Frame, TunnelFields.StreamId, 'Reason']

    public constructor(public readonly StreamId: number, public readonly Reason: StreamCloseReason)
    {
    }

    public static Read(fields: StrictFields): CloseStream
    {
        return new CloseStream(TunnelFields.ReadStreamId(fields), fields.Enum(CloseStream.Members[2] as string, CloseStream.Reasons))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Frame: this.Frame, StreamId: this.StreamId, Reason: this.Reason }
    }
}

export type TunnelFrame = TunnelReady | OpenStream | StreamOpened | CloseStream

/**
 * The tunnel's control frames: unsigned (the tunnel was authenticated by its signed hello and runs inside TLS to the
 * edge), strictly decoded, at most 4 KiB each. Stream ids are 1 to 2^31-1. Only the control plane is defined here; how
 * the stream bytes are multiplexed is the tunnel implementation's choice.
 */
export class TunnelFrames
{
    public static readonly MaxBytes = 4096
    public static readonly Kinds: readonly TunnelFrameKind[] = Object.values(TunnelFrameKind)

    public static Decode(text: string): TunnelFrame
    {
        return TunnelFrames.Parse(ProtocolJson.Parse(text, TunnelFrames.MaxBytes))
    }

    public static Parse(value: unknown, path: string = StrictFields.Root): TunnelFrame
    {
        const kind = StrictFields.Of(value, path).Enum(TunnelFields.Frame, TunnelFrames.Kinds)
        switch (kind)
        {
            case TunnelFrameKind.Ready:
                return TunnelReady.Read(StrictFields.Exactly(value, TunnelReady.Members, path))
            case TunnelFrameKind.OpenStream:
                return OpenStream.Read(StrictFields.Exactly(value, OpenStream.Members, path))
            case TunnelFrameKind.StreamOpened:
                return StreamOpened.Read(StrictFields.Exactly(value, StreamOpened.Members, path))
            case TunnelFrameKind.CloseStream:
                return CloseStream.Read(StrictFields.Exactly(value, CloseStream.Members, path))
        }
    }

    public static Encode(frame: TunnelFrame): string
    {
        return JSON.stringify(frame.ToJson())
    }
}
