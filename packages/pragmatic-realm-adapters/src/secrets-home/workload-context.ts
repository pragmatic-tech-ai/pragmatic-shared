import { readFile } from 'node:fs/promises'
import type { RealmSecretsOption } from './realm-secrets-option.js'
import { SecretsHomeFailure, SecretsHomeUnavailableError } from './secrets-home-unavailable-error.js'

/** The workload context is incomplete. */
export class WorkloadContextError extends Error
{
    public static readonly ErrorName = 'WorkloadContextError'

    public constructor(message: string)
    {
        super(message)
        this.name = WorkloadContextError.ErrorName
    }
}

/**
 * Who is asking a realm's secrets home: the realm, the component, and the path of the component's projected
 * service-account token (rotated by the kubelet, audience per cloud). The engine chart sets `PRAGMATIC_REALM_ID`,
 * `PRAGMATIC_COMPONENT` and `PRAGMATIC_WORKLOAD_TOKEN_FILE`. The token is read on every exchange, never cached here,
 * so a rotated token is what the next exchange presents.
 */
export class WorkloadContext
{
    public static readonly DefaultTokenPath = '/var/run/secrets/pragmatic/workload-identity/token'
    public static readonly RealmVariable = 'PRAGMATIC_REALM_ID'
    public static readonly ComponentVariable = 'PRAGMATIC_COMPONENT'
    public static readonly TokenVariable = 'PRAGMATIC_WORKLOAD_TOKEN_FILE'
    /** A realm id: one DNS label (the shape every realm secrets home and its grants take). */
    public static readonly RealmPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
    private static readonly ComponentPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
    private static readonly Encoding = 'utf8'
    public static readonly BadRealm = 'a realm id is lowercase letters, digits and "-" (at most 63)'
    private static readonly BadComponent = 'a component name is lowercase letters, digits and "-" (at most 63)'
    private static readonly MissingPrefix = 'the workload context needs '

    public constructor(public readonly RealmId: string, public readonly Component: string, public readonly TokenPath: string = WorkloadContext.DefaultTokenPath)
    {
        if (!WorkloadContext.RealmPattern.test(RealmId)) throw new WorkloadContextError(WorkloadContext.BadRealm)
        if (!WorkloadContext.ComponentPattern.test(Component)) throw new WorkloadContextError(WorkloadContext.BadComponent)
        Object.freeze(this)
    }

    /** From the environment the chart sets; `component` is the caller's own name when the environment has none. */
    public static FromEnvironment(env: Readonly<Record<string, string | undefined>>, component?: string): WorkloadContext
    {
        const W = WorkloadContext
        const realm = env[W.RealmVariable]
        const named = env[W.ComponentVariable]
        const token = env[W.TokenVariable]
        if (realm === undefined || realm === '') throw new WorkloadContextError(W.MissingPrefix + W.RealmVariable)
        const own = named === undefined || named === '' ? component : named
        if (own === undefined) throw new WorkloadContextError(W.MissingPrefix + W.ComponentVariable)
        return new WorkloadContext(realm, own, token === undefined || token === '' ? W.DefaultTokenPath : token)
    }

    /** The same workload acting for another realm (the realm sign-in service serves several). */
    public ForRealm(realm: string): WorkloadContext
    {
        return new WorkloadContext(realm, this.Component, this.TokenPath)
    }

    /** The projected token, trimmed; a missing, empty or unreadable file is `token-unreadable` for `option`. */
    public async ReadToken(option: RealmSecretsOption): Promise<string>
    {
        let text: string
        try
        {
            text = await readFile(this.TokenPath, WorkloadContext.Encoding)
        }
        catch
        {
            throw new SecretsHomeUnavailableError(option, SecretsHomeFailure.TokenUnreadable)
        }
        const token = text.trim()
        if (token === '') throw new SecretsHomeUnavailableError(option, SecretsHomeFailure.TokenUnreadable)
        return token
    }
}
