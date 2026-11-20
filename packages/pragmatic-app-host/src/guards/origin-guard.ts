import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { ForwardedHeader } from './forwarded-header.js'

/**
 * The mutation Origin check: an absent Origin is allowed (a non-browser caller or a same-origin navigation); a present
 * one must equal the request's own origin, scheme and port included. The scheme is https when the socket itself is TLS,
 * or when a trusted proxy reports https in the last x-forwarded-proto hop; http otherwise.
 */
export class OriginGuard
{
    private static readonly OriginHeader = 'origin'
    private static readonly HostHeader = 'host'
    private static readonly ForwardedProtoHeader = 'x-forwarded-proto'
    private static readonly HttpsProtocol = 'https'
    private static readonly HttpScheme = 'http://'
    private static readonly HttpsScheme = 'https://'

    public constructor(private readonly trustedProxy: boolean)
    {
    }

    public Allows(req: IncomingMessage): boolean
    {
        const origin = req.headers[OriginGuard.OriginHeader]
        if (origin === undefined)
        {
            return true
        }
        const host = req.headers[OriginGuard.HostHeader]
        return host !== undefined && origin.toLowerCase() === (this.Scheme(req) + host).toLowerCase()
    }

    /** The scheme (with `://`) the browser used to reach this host. */
    public Scheme(req: IncomingMessage): string
    {
        if ((req.socket as TLSSocket | undefined)?.encrypted === true)
        {
            return OriginGuard.HttpsScheme
        }
        if (this.trustedProxy && ForwardedHeader.LastHop(req, OriginGuard.ForwardedProtoHeader)?.toLowerCase() === OriginGuard.HttpsProtocol)
        {
            return OriginGuard.HttpsScheme
        }
        return OriginGuard.HttpScheme
    }
}
