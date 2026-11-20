import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigration, SqlMigrationModule } from '../sql/sql-migration.js'
import { SqlMigrationRunner } from '../sql/sql-migration-runner.js'

/** The master keys a SqlSecretStore seals under: the current one (new rows) and older ones still opening their
 *  rows until Rekey moves them. Key bytes come from the caller (a secret file); ids are the caller's names for them
 *  and are stored on each row. */
export class SqlSecretKeyRing
{
    private static readonly KeyLength = 32
    private static readonly BadKeyMessage = 'a master key must be exactly 32 bytes'
    private static readonly BadIdMessage = 'a master key id must not be empty'
    private static readonly NoCurrentMessage = 'the current key id is not in the key ring'

    private readonly keys: ReadonlyMap<string, Buffer>

    public constructor(public readonly CurrentId: string, keys: ReadonlyMap<string, Buffer>)
    {
        const copied = new Map<string, Buffer>()
        for (const [id, key] of keys)
        {
            if (id === '')
            {
                throw new Error(SqlSecretKeyRing.BadIdMessage)
            }
            if (key.length !== SqlSecretKeyRing.KeyLength)
            {
                throw new Error(SqlSecretKeyRing.BadKeyMessage)
            }
            copied.set(id, Buffer.from(key))
        }
        if (!copied.has(CurrentId))
        {
            throw new Error(SqlSecretKeyRing.NoCurrentMessage)
        }
        this.keys = copied
    }

    public static Single(id: string, key: Buffer): SqlSecretKeyRing
    {
        return new SqlSecretKeyRing(id, new Map([[id, key]]))
    }

    public get Current(): Buffer
    {
        return this.keys.get(this.CurrentId)!
    }

    public Key(id: string): Buffer | undefined
    {
        return this.keys.get(id)
    }
}

/** Schema of the sealed secrets table. */
export class SqlSecretMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE sealed_secrets (scope text NOT NULL, reference text NOT NULL, key_id text NOT NULL, nonce text NOT NULL, tag text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (scope, reference))',
    ])

    public readonly Name = 'secrets.sealed'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlSecretMigrations.V1]
    }
}

/** Postgres ISecretStore: one row per (scope, reference), sealed with AES-256-GCM under the key ring's current
 *  master key with a fresh 12-byte nonce per write. The associated data binds the row to its scope (the realm or
 *  application namespace the caller opens it for) and reference, so a sealed value copied to another row does not
 *  open. Each row records its key id; Get uses that key, Rekey re-seals every row of the scope under the current key.
 *  Behaviour matches FileEncryptedSecretStore (SecretStoreConformance): absence, a wrong key, an unknown key id or a
 *  tampered row all read as null, never throw. */
export class SqlSecretStore implements ISecretStore
{
    private static readonly Algorithm = 'aes-256-gcm'
    private static readonly NonceLength = 12
    private static readonly TagLength = 16
    private static readonly Encoding = 'base64'
    private static readonly PlaintextEncoding = 'utf8'
    private static readonly AadPrefix = 'pragmatic.sealed-secret.v1'
    private static readonly AadSeparator = '\u0000'
    private static readonly GetSql = 'SELECT key_id, nonce, tag, ciphertext FROM sealed_secrets WHERE scope = $1 AND reference = $2'
    private static readonly ListSql = 'SELECT reference, key_id, nonce, tag, ciphertext FROM sealed_secrets WHERE scope = $1 AND key_id <> $2'
    private static readonly UpsertSql = 'INSERT INTO sealed_secrets (scope, reference, key_id, nonce, tag, ciphertext, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (scope, reference) DO UPDATE SET key_id = EXCLUDED.key_id, nonce = EXCLUDED.nonce, tag = EXCLUDED.tag, ciphertext = EXCLUDED.ciphertext, updated_at = EXCLUDED.updated_at'
    private static readonly DeleteSql = 'DELETE FROM sealed_secrets WHERE scope = $1 AND reference = $2'

    private constructor(private readonly session: ISqlSession, private readonly keys: SqlSecretKeyRing, private readonly scope: string)
    {
    }

    public static async Open(session: ISqlSession, keys: SqlSecretKeyRing, scope: string): Promise<SqlSecretStore>
    {
        await SqlMigrationRunner.Run(session, new SqlSecretMigrations())
        return new SqlSecretStore(session, keys, scope)
    }

    public async Get(reference: string): Promise<string | null>
    {
        const rows = await this.session.Query(SqlSecretStore.GetSql, [this.scope, reference])
        return rows[0] === undefined ? null : this.Unseal(reference, rows[0])
    }

    public async Put(reference: string, secret: string): Promise<void>
    {
        const nonce = randomBytes(SqlSecretStore.NonceLength)
        const cipher = createCipheriv(SqlSecretStore.Algorithm, this.keys.Current, nonce, { authTagLength: SqlSecretStore.TagLength })
        cipher.setAAD(this.Aad(reference))
        const ciphertext = Buffer.concat([cipher.update(secret, SqlSecretStore.PlaintextEncoding), cipher.final()])
        const tag = cipher.getAuthTag()
        await this.session.Execute(SqlSecretStore.UpsertSql, [this.scope, reference, this.keys.CurrentId, nonce.toString(SqlSecretStore.Encoding), tag.toString(SqlSecretStore.Encoding), ciphertext.toString(SqlSecretStore.Encoding)])
    }

    public async Delete(reference: string): Promise<void>
    {
        await this.session.Execute(SqlSecretStore.DeleteSql, [this.scope, reference])
    }

    /** Re-seals every row of this scope that is under an older key with the current key; returns how many moved.
     *  Rows whose key the ring does not hold (or that fail to open) are left as they are. */
    public async Rekey(): Promise<number>
    {
        let moved = 0
        for (const row of await this.session.Query(SqlSecretStore.ListSql, [this.scope, this.keys.CurrentId]))
        {
            const reference = String(row.reference)
            const plaintext = this.Unseal(reference, row)
            if (plaintext !== null)
            {
                await this.Put(reference, plaintext)
                moved++
            }
        }
        return moved
    }

    private Unseal(reference: string, row: SqlRow): string | null
    {
        const key = this.keys.Key(String(row.key_id))
        if (key === undefined)
        {
            return null
        }
        try
        {
            const decipher = createDecipheriv(SqlSecretStore.Algorithm, key, Buffer.from(String(row.nonce), SqlSecretStore.Encoding), { authTagLength: SqlSecretStore.TagLength })
            decipher.setAAD(this.Aad(reference))
            decipher.setAuthTag(Buffer.from(String(row.tag), SqlSecretStore.Encoding))
            return Buffer.concat([decipher.update(Buffer.from(String(row.ciphertext), SqlSecretStore.Encoding)), decipher.final()]).toString(SqlSecretStore.PlaintextEncoding)
        }
        catch
        {
            // Wrong key, tampered row or a row moved from another (scope, reference): fail closed.
            return null
        }
    }

    private Aad(reference: string): Buffer
    {
        return Buffer.from([SqlSecretStore.AadPrefix, this.scope, reference].join(SqlSecretStore.AadSeparator), SqlSecretStore.PlaintextEncoding)
    }
}
