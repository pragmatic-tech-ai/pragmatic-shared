import type { IncomingMessage } from 'node:http'

/** Reads the hop a trusted proxy appended to a comma-separated forwarding header: the last one (earlier hops are
 *  whatever the client sent and are never trusted). Repeated headers are joined first. */
export class ForwardedHeader
{
    private static readonly Separator = ','

    public static LastHop(req: IncomingMessage, header: string): string | undefined
    {
        const raw = req.headers[header]
        const joined = Array.isArray(raw) ? raw.join(ForwardedHeader.Separator) : raw
        const last = joined?.split(ForwardedHeader.Separator).pop()?.trim()
        return last === undefined || last.length === 0 ? undefined : last
    }
}
