import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { IdpDirectorySnapshot, IdpUserState, UnreadableIdpDirectoryRecordError } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IIdpDirectoryStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlIdpDirectoryMigrations } from './sql-identity-migrations.js'

/** Postgres-backed IdP directory snapshots, one row per realm (realm_id is the primary key, so realms never
 *  collide): taken_at (ISO text), authoritative, user states and group member ids as JSON [key, value] pair
 *  arrays. Ids are stored exactly as the directory source produced them (any case folding, e.g. the Entra
 *  lowercase form, is the source's job). Mirrors FileIdpDirectoryStore: a stored row that does not parse (bad
 *  shape, unknown user state, invalid timestamp) fails closed: Get throws UnreadableIdpDirectoryRecordError for
 *  that realm instead of reading its users as Unknown (active); the next Save replaces it. */
export class SqlIdpDirectoryStore implements IIdpDirectoryStore
{
    private static readonly Table = 'identity_idp_directory'
    private static readonly PairLength = 2
    private static readonly ShapeReason = 'record shape is invalid'
    private static readonly StateReason = 'unknown user state'
    private static readonly TakenAtReason = 'invalid snapshot timestamp'
    private static readonly States: ReadonlySet<string> = new Set<string>(Object.values(IdpUserState))

    private readonly session: ISqlSession

    private constructor(session: ISqlSession)
    {
        this.session = session
    }

    public static async Open(session: ISqlSession): Promise<SqlIdpDirectoryStore>
    {
        await SqlMigrationRunner.Run(session, new SqlIdpDirectoryMigrations())
        return new SqlIdpDirectoryStore(session)
    }

    public async Get(realmId: string): Promise<IdpDirectorySnapshot | null>
    {
        const rows = await this.session.Query(`SELECT taken_at, authoritative, users, groups FROM ${SqlIdpDirectoryStore.Table} WHERE realm_id = $1`, [realmId])
        if (rows[0] === undefined)
        {
            return null
        }
        return SqlIdpDirectoryStore.Parse(realmId, rows[0])
    }

    public async Save(realmId: string, snapshot: IdpDirectorySnapshot): Promise<void>
    {
        const users = JSON.stringify([...snapshot.Users()])
        const groups = JSON.stringify([...snapshot.Groups()].map(([id, members]) => [id, [...members]]))
        await this.session.Execute(`INSERT INTO ${SqlIdpDirectoryStore.Table} (realm_id, taken_at, authoritative, users, groups) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (realm_id) DO UPDATE SET taken_at = $2, authoritative = $3, users = $4, groups = $5`, [realmId, snapshot.TakenAt.toISOString(), snapshot.Authoritative, users, groups])
    }

    private static Parse(realmId: string, row: SqlRow): IdpDirectorySnapshot
    {
        if (typeof row.authoritative !== 'boolean' || typeof row.taken_at !== 'string')
        {
            throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.ShapeReason)
        }
        const takenAt = new Date(row.taken_at)
        if (Number.isNaN(takenAt.getTime()))
        {
            throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.TakenAtReason)
        }
        const users = new Map<string, IdpUserState>()
        for (const entry of SqlIdpDirectoryStore.Pairs(realmId, row.users))
        {
            if (!Array.isArray(entry) || entry.length !== SqlIdpDirectoryStore.PairLength || typeof entry[0] !== 'string')
            {
                throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.ShapeReason)
            }
            if (typeof entry[1] !== 'string' || !SqlIdpDirectoryStore.States.has(entry[1]))
            {
                throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.StateReason)
            }
            users.set(entry[0], entry[1] as IdpUserState)
        }
        const groups = new Map<string, readonly string[]>()
        for (const entry of SqlIdpDirectoryStore.Pairs(realmId, row.groups))
        {
            if (!Array.isArray(entry) || entry.length !== SqlIdpDirectoryStore.PairLength || typeof entry[0] !== 'string'
                || !Array.isArray(entry[1]) || (entry[1] as unknown[]).some(m => typeof m !== 'string'))
            {
                throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.ShapeReason)
            }
            groups.set(entry[0], entry[1] as string[])
        }
        return new IdpDirectorySnapshot(takenAt, row.authoritative, users, groups)
    }

    /** Parses one JSON pair-array column; anything that is not valid JSON or not an array fails closed. */
    private static Pairs(realmId: string, column: unknown): readonly unknown[]
    {
        let parsed: unknown
        try
        {
            parsed = typeof column === 'string' ? JSON.parse(column) : undefined
        }
        catch
        {
            parsed = undefined
        }
        if (!Array.isArray(parsed))
        {
            throw new UnreadableIdpDirectoryRecordError(realmId, SqlIdpDirectoryStore.ShapeReason)
        }
        return parsed
    }
}
