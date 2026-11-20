import { createHash, randomBytes } from 'node:crypto'
import type { ITicketRepository } from './ticket-repository.js'

export interface WsTicketStoreOptions
{
    /** Default 30 s: a ticket is minted right before the upgrade it authenticates. */
    TtlMs?: number
    Now?: () => number
}

/**
 * Single-use, short-lived tickets that let a browser authenticate a WebSocket upgrade through its subprotocol (no
 * token in the URL, no cookie on a cross-site upgrade). A ticket binds a session id (the token digest, never the
 * token); the repository stores only the ticket's digest.
 */
export class WsTicketStore
{
    private static readonly DefaultTtlMs = 30_000
    private static readonly TicketBytes = 24
    private static readonly TicketEncoding = 'base64url'
    private static readonly DigestAlgorithm = 'sha256'
    private static readonly DigestEncoding = 'base64url'

    private readonly ttlMs: number
    private readonly now: () => number

    public constructor(private readonly repository: ITicketRepository, options: WsTicketStoreOptions = {})
    {
        this.ttlMs = options.TtlMs ?? WsTicketStore.DefaultTtlMs
        this.now = options.Now ?? Date.now
    }

    /** An opaque single-use ticket bound to the session. */
    public async Mint(sessionId: string): Promise<string>
    {
        const ticket = randomBytes(WsTicketStore.TicketBytes).toString(WsTicketStore.TicketEncoding)
        await this.repository.Put(WsTicketStore.DigestOf(ticket), sessionId, this.now() + this.ttlMs)
        return ticket
    }

    /** The bound session id exactly once; null when unknown, expired or already used. */
    public async Redeem(ticket: string): Promise<string | null>
    {
        return ticket.length === 0 ? null : await this.repository.Take(WsTicketStore.DigestOf(ticket))
    }

    private static DigestOf(ticket: string): string
    {
        return createHash(WsTicketStore.DigestAlgorithm).update(ticket).digest(WsTicketStore.DigestEncoding)
    }
}
