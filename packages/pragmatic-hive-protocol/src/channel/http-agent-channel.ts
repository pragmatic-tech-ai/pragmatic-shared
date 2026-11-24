import type { IAgentChannel } from './agent-channel.js'
import { AgentExchangeLink, type AgentExchangeRefusal } from './agent-exchange-link.js'
import { SignedEnvelope } from '../envelope/signed-envelope.js'
import { ProtocolDecodeError } from '../wire/protocol-decode-error.js'

/** Why an exchange over HTTP gave no answer to verify. */
export enum AgentChannelFailure
{
    /** The platform could not be reached, or did not answer within the deadline. */
    Unreachable = 'The agent channel could not be reached.',
    /** The platform answered with a refusal or an unexpected status. */
    Refused = 'The agent channel refused the message.',
    /** The answer was over the size limit or not an envelope. */
    BadAnswer = 'The agent channel answered something that is not an envelope.',
}

/**
 * The agent channel did not give an answer to verify. `Status` is the HTTP status when there was one (null when the
 * platform was unreachable), `Code` the platform's refusal code when its answer named one of ours. Carries no text
 * from the answer.
 */
export class AgentChannelUnavailableError extends Error
{
    private static readonly ErrorName = 'AgentChannelUnavailableError'

    public constructor(public readonly Failure: AgentChannelFailure, public readonly Status: number | null = null, public readonly Code: AgentExchangeRefusal | null = null)
    {
        super(Failure)
        this.name = AgentChannelUnavailableError.ErrorName
    }
}

/**
 * The agent's IAgentChannel over HTTPS (C3.3): `POST <channelUrl>/agent/v2/exchange` with the envelope's wire text,
 * global `fetch`, a 30-second deadline for the whole exchange; 200 is the platform's envelope, 204 null, anything else
 * AgentChannelUnavailableError with the status and the refusal code. An answer over 1 MiB is refused unread (by its
 * declared length, else while streaming). No dependency beyond Node, so the hive and host agents stay TODL-free.
 */
export class HttpAgentChannel implements IAgentChannel
{
    public static readonly DefaultTimeoutMs = 30_000
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly PathSeparator = '/'
    private static readonly Utf8 = 'utf8'

    private readonly url: string

    public constructor(channelUrl: string, private readonly timeoutMs: number = HttpAgentChannel.DefaultTimeoutMs)
    {
        this.url = HttpAgentChannel.ExchangeUrl(channelUrl)
    }

    /** `<channelUrl>/agent/v2/exchange`, one separator whatever the channel URL ends with. */
    public static ExchangeUrl(channelUrl: string): string
    {
        const base = channelUrl.endsWith(HttpAgentChannel.PathSeparator) ? channelUrl.slice(0, -1) : channelUrl
        return base + AgentExchangeLink.PublicPath
    }

    public get Url(): string
    {
        return this.url
    }

    public async Exchange(request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        const H = HttpAgentChannel
        let response: Response
        try
        {
            response = await fetch(this.url, {
                method: H.MethodPost,
                headers: { [H.ContentTypeHeader]: AgentExchangeLink.ContentType },
                body: request.Encode(),
                signal: AbortSignal.timeout(this.timeoutMs),
            })
        }
        catch
        {
            throw new AgentChannelUnavailableError(AgentChannelFailure.Unreachable)
        }
        if (response.status === AgentExchangeLink.StatusAcknowledged)
        {
            await H.Discard(response)
            return null
        }
        const text = await H.ReadLimited(response)
        if (response.status !== AgentExchangeLink.StatusAnswered)
        {
            throw new AgentChannelUnavailableError(AgentChannelFailure.Refused, response.status, AgentExchangeLink.CodeOf(H.JsonOrNull(text)))
        }
        try
        {
            return SignedEnvelope.Decode(text)
        }
        catch (error)
        {
            if (error instanceof ProtocolDecodeError)
            {
                throw new AgentChannelUnavailableError(AgentChannelFailure.BadAnswer, response.status)
            }
            throw error
        }
    }

    /** The body as text, refused when over the limit: by its declared length unread, else while streaming. */
    private static async ReadLimited(response: Response): Promise<string>
    {
        const H = HttpAgentChannel
        const declared = Number(response.headers.get(H.ContentLengthHeader) ?? Number.NaN)
        if (Number.isFinite(declared) && declared > AgentExchangeLink.BodyLimit)
        {
            await H.Discard(response)
            throw new AgentChannelUnavailableError(AgentChannelFailure.BadAnswer, response.status)
        }
        if (response.body === null)
        {
            return ''
        }
        const chunks: Buffer[] = []
        let size = 0
        try
        {
            for await (const chunk of response.body)
            {
                size += chunk.byteLength
                if (size > AgentExchangeLink.BodyLimit)
                {
                    throw new AgentChannelUnavailableError(AgentChannelFailure.BadAnswer, response.status)
                }
                chunks.push(Buffer.from(chunk))
            }
        }
        catch (error)
        {
            if (error instanceof AgentChannelUnavailableError)
            {
                await H.Discard(response)
                throw error
            }
            throw new AgentChannelUnavailableError(AgentChannelFailure.Unreachable, response.status)
        }
        return Buffer.concat(chunks).toString(H.Utf8)
    }

    private static async Discard(response: Response): Promise<void>
    {
        try
        {
            await response.body?.cancel()
        }
        catch
        {
            // Nothing to keep from a body that is not read.
        }
    }

    private static JsonOrNull(text: string): unknown
    {
        try
        {
            return JSON.parse(text) as unknown
        }
        catch
        {
            return null
        }
    }
}
