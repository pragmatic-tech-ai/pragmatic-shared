import { readFile } from 'node:fs/promises'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { PgSession } from '../sql/pg-session.js'
import { SqlSecretKeyRing, SqlSecretStore } from '../secrets/sql-secret-store.js'
import type { IRealmSecretsHomeFactory } from './realm-secrets-home.js'
import { RealmSecretName } from './realm-secret-name.js'
import { RealmSecretsOption } from './realm-secrets-option.js'
import { RealmSecretsSettingRule, type RealmSecretsSettings } from './realm-secrets-settings.js'
import { SecretsHomeFailure, SecretsHomeUnavailableError } from './secrets-home-unavailable-error.js'
import type { WorkloadContext } from './workload-context.js'

/** How the custom home reaches the `realm_secrets` database. */
export interface IRealmSecretsDatabase
{
    Session(): Promise<ISqlSession>
}

/** A custom home's store was asked for a pinned version: it holds one value per name. */
export class UnversionedSecretsHomeError extends Error
{
    public static readonly ErrorName = 'UnversionedSecretsHomeError'
    public static readonly Code = 'unversioned'
    private static readonly Message = 'the custom realm secrets home holds no versions; refer to the secret without @<version>'

    public readonly code = UnversionedSecretsHomeError.Code

    public constructor()
    {
        super(UnversionedSecretsHomeError.Message)
        this.name = UnversionedSecretsHomeError.ErrorName
    }
}

/** The `realm_secrets` database from a mounted database URL file (the chart's per-component Secret). */
export class UrlFileRealmSecretsDatabase implements IRealmSecretsDatabase
{
    private static readonly Encoding = 'utf8'
    private static readonly MaxConnections = 4
    private static readonly ErrorEvent = 'error'

    private session: Promise<ISqlSession> | undefined

    public constructor(private readonly urlFile: string)
    {
    }

    public Session(): Promise<ISqlSession>
    {
        if (this.session === undefined)
        {
            const opening = this.Open()
            this.session = opening
            opening.catch(() =>
            {
                if (this.session === opening) this.session = undefined
            })
        }
        return this.session
    }

    private async Open(): Promise<ISqlSession>
    {
        const U = UrlFileRealmSecretsDatabase
        let url: string
        try
        {
            url = (await readFile(this.urlFile, U.Encoding)).trim()
        }
        catch
        {
            throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.Unreachable)
        }
        if (url === '') throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.Unreachable)
        const pg = (await import('pg')).default
        const pool = new pg.Pool({ connectionString: url, max: U.MaxConnections, allowExitOnIdle: true })
        // An idle client failing (Postgres restarted) must not crash the process; the pool reconnects on the next query.
        pool.on(U.ErrorEvent, () => undefined)
        return new PgSession(pool)
    }
}

/**
 * The realm's secrets in the custom home: rows of the `realm_secrets` database's sealed-secrets table, scope
 * `realm/<realm>`, sealed with AES-256-GCM under the realm master key. Every component of the realm shares the
 * database; the tenant admin console's role writes, the others read (`RealmSecretsProvisioning`'s grants and
 * row-level security), so this store refuses writes when opened for reading before the database would.
 *
 * The key check row (reference `.key-check`, never a realm secret's name) holds a fixed text sealed under the master
 * key: the writer writes it on first use, and every open checks that it opens with the mounted key, so a replaced
 * master key is refused (`key-mismatch`) instead of reading every secret as absent.
 */
export class CustomRealmSecretStore implements ISecretStore
{
    private static readonly ScopePrefix = 'realm/'
    private static readonly KeyCheckReference = '.key-check'
    private static readonly KeyCheckText = 'pragmatic.realm-secrets.key-check.v1'
    private static readonly ExistsSql = 'SELECT 1 AS present FROM sealed_secrets WHERE scope = $1 AND reference = $2'
    private static readonly PermissionCodes: ReadonlySet<string> = new Set(['42501', '28000', '28P01'])
    private static readonly MissingCodes: ReadonlySet<string> = new Set(['3D000', '42P01'])

    private ready: Promise<SqlSecretStore> | undefined

    public constructor(
        private readonly database: IRealmSecretsDatabase,
        private readonly keys: () => Promise<SqlSecretKeyRing>,
        public readonly RealmId: string,
        public readonly Writer: boolean)
    {
    }

    public get Scope(): string
    {
        return CustomRealmSecretStore.ScopePrefix + this.RealmId
    }

    /** Opens the home and checks the master key against the key check row (writing it when the writer finds none). */
    public async Verify(): Promise<void>
    {
        await this.Store()
    }

    public async Get(key: string): Promise<string | null>
    {
        const name = RealmSecretName.TryParse(key)
        if (name === undefined) return null
        if (name.Version !== undefined) throw new UnversionedSecretsHomeError()
        const store = await this.Store()
        return this.Guarded(() => store.Get(name.Name))
    }

    public async Put(key: string, secret: string): Promise<void>
    {
        const name = RealmSecretName.ForWrite(key)
        if (!this.Writer) throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.PermissionDenied)
        const store = await this.Store()
        await this.Guarded(() => store.Put(name.Name, secret))
    }

    public async Delete(key: string): Promise<void>
    {
        const name = RealmSecretName.ForWrite(key)
        if (!this.Writer) throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.PermissionDenied)
        const store = await this.Store()
        await this.Guarded(() => store.Delete(name.Name))
    }

    private Store(): Promise<SqlSecretStore>
    {
        if (this.ready === undefined)
        {
            const opening = this.Open()
            this.ready = opening
            opening.catch(() =>
            {
                if (this.ready === opening) this.ready = undefined
            })
        }
        return this.ready
    }

    private async Open(): Promise<SqlSecretStore>
    {
        const C = CustomRealmSecretStore
        const keys = await this.keys()
        const session = await this.Guarded(() => this.database.Session())
        const store = SqlSecretStore.Over(session, keys, this.Scope)
        const present = await this.Guarded(() => session.Query(C.ExistsSql, [this.Scope, C.KeyCheckReference]))
        if (present.length > 0)
        {
            if (await this.Guarded(() => store.Get(C.KeyCheckReference)) !== C.KeyCheckText)
            {
                throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.KeyMismatch)
            }
        }
        else if (this.Writer)
        {
            await this.Guarded(() => store.Put(C.KeyCheckReference, C.KeyCheckText))
        }
        return store
    }

    // Database failures as the home's typed codes; never the driver's message (it can name roles, hosts, statements).
    private async Guarded<T>(work: () => Promise<T>): Promise<T>
    {
        try
        {
            return await work()
        }
        catch (error)
        {
            throw CustomRealmSecretStore.Typed(error)
        }
    }

    private static Typed(error: unknown): SecretsHomeUnavailableError
    {
        if (error instanceof SecretsHomeUnavailableError) return error
        const C = CustomRealmSecretStore
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'string' && C.PermissionCodes.has(code)) return new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.PermissionDenied)
        if (typeof code === 'string' && C.MissingCodes.has(code)) return new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.NotFound)
        return new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.Unreachable)
    }
}

/**
 * The custom option's secrets home: the realm's rows in the hive's `realm_secrets` database (`CustomRealmSecretStore`).
 * Settings: `databaseUrlFile` (the component's mounted database URL; its role decides what it may do), `masterKeyFile`
 * (the mounted `pragmatic-realm-master-key`: 32 bytes, raw or base64) and `access` (`writer` for the tenant admin
 * console, `reader` otherwise). No workload identity: Postgres roles and the mounted key are the access control.
 */
export class CustomRealmSecrets implements IRealmSecretsHomeFactory
{
    public static readonly DatabaseUrlFile = 'databaseUrlFile'
    public static readonly MasterKeyFile = 'masterKeyFile'
    public static readonly Access = 'access'
    public static readonly WriterAccess = 'writer'
    public static readonly ReaderAccess = 'reader'
    private static readonly KeyId = 'realm-master'
    private static readonly KeyBytes = 32
    private static readonly Base64 = 'base64'
    private static readonly Latin1 = 'latin1'
    private static readonly Base64Key = /^[A-Za-z0-9+/]{43}=$/
    private static readonly PathPattern = /^(\/|[A-Za-z]:[\\/])[^\u0000]{1,1023}$/
    private static readonly AccessPattern = /^(writer|reader)$/
    private static readonly PathForm = 'an absolute file path'
    private static readonly AccessForm = 'writer or reader'

    public readonly Option = RealmSecretsOption.Custom
    public readonly Settings: readonly RealmSecretsSettingRule[] = [
        new RealmSecretsSettingRule(CustomRealmSecrets.DatabaseUrlFile, CustomRealmSecrets.PathPattern, true, CustomRealmSecrets.PathForm),
        new RealmSecretsSettingRule(CustomRealmSecrets.MasterKeyFile, CustomRealmSecrets.PathPattern, true, CustomRealmSecrets.PathForm),
        new RealmSecretsSettingRule(CustomRealmSecrets.Access, CustomRealmSecrets.AccessPattern, false, CustomRealmSecrets.AccessForm),
    ]

    public Open(settings: RealmSecretsSettings, context: WorkloadContext): Promise<ISecretStore>
    {
        const C = CustomRealmSecrets
        const keyFile = settings.Get(C.MasterKeyFile)!
        const database = new UrlFileRealmSecretsDatabase(settings.Get(C.DatabaseUrlFile)!)
        return Promise.resolve(new CustomRealmSecretStore(database, () => C.ReadKeys(keyFile), context.RealmId, settings.Get(C.Access) === C.WriterAccess))
    }

    /** A store over a session the caller holds (tests, the bootstrap). */
    public static Over(session: ISqlSession, masterKey: Buffer, realm: string, writer: boolean): CustomRealmSecretStore
    {
        const keys = SqlSecretKeyRing.Single(CustomRealmSecrets.KeyId, masterKey)
        return new CustomRealmSecretStore({ Session: () => Promise.resolve(session) }, () => Promise.resolve(keys), realm, writer)
    }

    /** The master key file as a key ring: exactly 32 raw bytes, or their base64 text. */
    public static async ReadKeys(file: string): Promise<SqlSecretKeyRing>
    {
        const C = CustomRealmSecrets
        let bytes: Buffer
        try
        {
            bytes = await readFile(file)
        }
        catch
        {
            throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.KeyMismatch)
        }
        const text = bytes.toString(C.Latin1).trim()
        const key = bytes.length === C.KeyBytes ? bytes : C.Base64Key.test(text) ? Buffer.from(text, C.Base64) : undefined
        if (key === undefined || key.length !== C.KeyBytes) throw new SecretsHomeUnavailableError(RealmSecretsOption.Custom, SecretsHomeFailure.KeyMismatch)
        return SqlSecretKeyRing.Single(C.KeyId, key)
    }
}
