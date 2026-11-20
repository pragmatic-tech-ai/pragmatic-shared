/** Where WebSocket tickets live between mint and redeem, keyed by the ticket's digest. Take removes and returns the
 *  bound session id exactly once (null when unknown or expired). */
export interface ITicketRepository
{
    Put(ticketHash: string, sessionId: string, expiresAt: number): Promise<void>
    Take(ticketHash: string): Promise<string | null>
}

/** Process-local tickets, bounded: past MaxTickets the oldest is evicted; expired ones are pruned on Put. */
export class InMemoryTicketRepository implements ITicketRepository
{
    private static readonly DefaultMaxTickets = 1024

    private readonly tickets = new Map<string, { SessionId: string, ExpiresAt: number }>()

    public constructor(private readonly maxTickets: number = InMemoryTicketRepository.DefaultMaxTickets, private readonly now: () => number = Date.now)
    {
    }

    public async Put(ticketHash: string, sessionId: string, expiresAt: number): Promise<void>
    {
        const now = this.now()
        for (const [hash, entry] of this.tickets)
        {
            if (entry.ExpiresAt <= now)
            {
                this.tickets.delete(hash)
            }
        }
        while (this.tickets.size >= this.maxTickets)
        {
            const oldest = this.tickets.keys().next()
            if (oldest.done === true)
            {
                break
            }
            this.tickets.delete(oldest.value)
        }
        this.tickets.set(ticketHash, { SessionId: sessionId, ExpiresAt: expiresAt })
    }

    public async Take(ticketHash: string): Promise<string | null>
    {
        const entry = this.tickets.get(ticketHash)
        if (entry === undefined)
        {
            return null
        }
        this.tickets.delete(ticketHash)
        return entry.ExpiresAt > this.now() ? entry.SessionId : null
    }
}
