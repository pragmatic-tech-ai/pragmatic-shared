import { randomBytes, createHash } from 'node:crypto'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { ServiceTokenGrant, ServiceTokenSummary } from '@pragmatic-tech-ai/pragmatic-identity'
import type { Realm, PresentedSecret, IServiceTokenStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'
import { SqlServiceTokenMigrations } from './sql-identity-migrations.js'

/** Postgres-backed service-token store. Mirrors FileServiceTokenStore: a 32-byte base64url token, stored by
 *  its sha256(base64url) hash (the raw token never persists); tokenRef = realmId + '/svctok/' + hash;
 *  resolve rejects revoked / wrong-realm / expired; scopes persist as a JSON array. */
export class SqlServiceTokenStore implements IServiceTokenStore
{
    private static readonly Table = 'identity_service_tokens'
    private static readonly TokenBytes = 32
    private static readonly TokenEncoding = 'base64url'
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'base64url'
    private static readonly RefSegment = '/svctok/'
    private static readonly RefSeparator = '/'

    private readonly session: ISqlSession
    private readonly now: () => Date

    private constructor(session: ISqlSession, now: () => Date)
    {
        this.session = session
        this.now = now
    }

    public static async Open(session: ISqlSession, now: () => Date = () => new Date()): Promise<SqlServiceTokenStore>
    {
        await SqlMigrationRunner.Run(session, new SqlServiceTokenMigrations())
        return new SqlServiceTokenStore(session, now)
    }

    public async Issue(realm: Realm, principalId: string, scopes: readonly string[], expiresAt: Date | null): Promise<{ Grant: ServiceTokenGrant; Token: string }>
    {
        const token = randomBytes(SqlServiceTokenStore.TokenBytes).toString(SqlServiceTokenStore.TokenEncoding)
        const hash = SqlServiceTokenStore.Hash(token)
        const tokenRef = realm.Id + SqlServiceTokenStore.RefSegment + hash
        const expiresIso = expiresAt === null ? null : expiresAt.toISOString()
        await this.session.Execute(`INSERT INTO ${SqlServiceTokenStore.Table} (hash, token_ref, principal_id, realm_id, scopes, expires_at, revoked) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [hash, tokenRef, principalId, realm.Id, JSON.stringify([...scopes]), expiresIso, false])
        return { Grant: new ServiceTokenGrant(tokenRef, principalId, realm.Id, [...scopes], expiresAt), Token: token }
    }

    public async Resolve(realm: Realm, presented: PresentedSecret): Promise<ServiceTokenGrant | null>
    {
        const rows = await this.session.Query(`SELECT token_ref, principal_id, realm_id, scopes, expires_at, revoked FROM ${SqlServiceTokenStore.Table} WHERE hash = $1`, [SqlServiceTokenStore.Hash(presented.Reveal())])
        const row = rows[0]
        if (row === undefined || row.revoked === true || String(row.realm_id) !== realm.Id)
        {
            return null
        }
        const expiresAt = row.expires_at === null ? null : new Date(String(row.expires_at))
        if (expiresAt !== null && expiresAt.getTime() <= this.now().getTime())
        {
            return null
        }
        return new ServiceTokenGrant(String(row.token_ref), String(row.principal_id), String(row.realm_id), JSON.parse(String(row.scopes)) as string[], expiresAt)
    }

    public async Revoke(realm: Realm, tokenRef: string): Promise<void>
    {
        const hash = tokenRef.slice(tokenRef.lastIndexOf(SqlServiceTokenStore.RefSeparator) + 1)
        await this.session.Execute(`UPDATE ${SqlServiceTokenStore.Table} SET revoked = $1 WHERE hash = $2 AND token_ref = $3 AND realm_id = $4`, [true, hash, tokenRef, realm.Id])
    }

    public async List(realm: Realm): Promise<readonly ServiceTokenSummary[]>
    {
        const rows = await this.session.Query(`SELECT token_ref, principal_id, scopes, expires_at, revoked FROM ${SqlServiceTokenStore.Table} WHERE realm_id = $1`, [realm.Id])
        return rows.map(row => new ServiceTokenSummary(String(row.token_ref), String(row.principal_id), JSON.parse(String(row.scopes)) as string[], row.expires_at === null ? null : new Date(String(row.expires_at)), row.revoked === true))
    }

    private static Hash(token: string): string
    {
        return createHash(SqlServiceTokenStore.HashAlgorithm).update(token).digest(SqlServiceTokenStore.HashEncoding)
    }
}
