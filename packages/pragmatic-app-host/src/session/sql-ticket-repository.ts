import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { ITicketRepository } from './ticket-repository.js'

/** Schema of the pending WebSocket tickets (expiry in epoch milliseconds). */
export class SqlTicketMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE app_host_ws_tickets (ticket_hash text PRIMARY KEY, session_id text NOT NULL, expires_at bigint NOT NULL)',
        'CREATE INDEX app_host_ws_tickets_expires ON app_host_ws_tickets (expires_at)',
    ])

    public readonly Name = 'app_host.ws_tickets'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlTicketMigrations.V1]
    }
}

/** Postgres ITicketRepository: a ticket minted on one replica redeems on another. Take is one `DELETE ... RETURNING`,
 *  so exactly one caller gets a ticket; Put sweeps tickets that expired unused. */
export class SqlTicketRepository implements ITicketRepository
{
    private static readonly PutSql = 'INSERT INTO app_host_ws_tickets (ticket_hash, session_id, expires_at) VALUES ($1, $2, $3)'
    private static readonly SweepSql = 'DELETE FROM app_host_ws_tickets WHERE expires_at <= $1'
    private static readonly TakeSql = 'DELETE FROM app_host_ws_tickets WHERE ticket_hash = $1 RETURNING session_id, expires_at'

    private constructor(private readonly session: ISqlSession, private readonly now: () => number)
    {
    }

    public static async Open(session: ISqlSession, now: () => number = Date.now): Promise<SqlTicketRepository>
    {
        await SqlMigrationRunner.Run(session, new SqlTicketMigrations())
        return new SqlTicketRepository(session, now)
    }

    public async Put(ticketHash: string, sessionId: string, expiresAt: number): Promise<void>
    {
        await this.session.Execute(SqlTicketRepository.SweepSql, [this.now()])
        await this.session.Execute(SqlTicketRepository.PutSql, [ticketHash, sessionId, expiresAt])
    }

    public async Take(ticketHash: string): Promise<string | null>
    {
        const row = (await this.session.Query(SqlTicketRepository.TakeSql, [ticketHash]))[0]
        if (row === undefined)
        {
            return null
        }
        return Number(row.expires_at) > this.now() ? String(row.session_id) : null
    }
}
