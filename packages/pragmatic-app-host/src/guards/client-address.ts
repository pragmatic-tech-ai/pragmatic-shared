import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { ForwardedHeader } from './forwarded-header.js'

/** The client address the throttles key on: the socket peer, or (behind a trusted proxy) the last x-forwarded-for
 *  hop, the one the proxy itself appended, but only when it is a valid IP address. Without a trusted proxy the header
 *  is ignored, so a client cannot pick its own throttle bucket. */
export class ClientAddress
{
    private static readonly ForwardedForHeader = 'x-forwarded-for'
    private static readonly Unknown = ''
    private static readonly NotAnAddress = 0

    public constructor(private readonly trustedProxy: boolean)
    {
    }

    public Of(req: IncomingMessage): string
    {
        const socket = req.socket?.remoteAddress ?? ClientAddress.Unknown
        if (!this.trustedProxy)
        {
            return socket
        }
        const last = ForwardedHeader.LastHop(req, ClientAddress.ForwardedForHeader)
        return last !== undefined && isIP(last) !== ClientAddress.NotAnAddress ? last : socket
    }
}
