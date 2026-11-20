import { HostAllowList } from '../guards/host-allow-list.js'
import { SecurityHeaders } from '../bundle/security-headers.js'
import type { SecurityHeadersOptions } from '../bundle/security-headers.js'

export interface AppHostConfigOptions
{
    /** Host names the application answers on, besides the loopback names (always allowed). */
    AllowedHosts?: Iterable<string>
    /** Behind a trusted reverse proxy: honour the last x-forwarded-for / x-forwarded-proto hop. Default false. */
    TrustedProxy?: boolean
    /** Paths under this prefix are the JSON API: never the UI bundle, an unknown one is a JSON 404. Default `/api/`. */
    ApiPrefix?: string
    /** Body limit of a route that declares none, in bytes. Default 1 MiB. */
    DefaultBodyLimit?: number
    /** The session claim an audit entry names its actor by (falling back to the subject). Default `email`. */
    AuditActorClaim?: string
    Security?: SecurityHeadersOptions
}

/** The plain settings of an AppHost (its collaborators are AppHostModules). */
export class AppHostConfig
{
    private static readonly DefaultApiPrefix = '/api/'
    private static readonly DefaultBodyLimit = 1024 * 1024
    private static readonly DefaultAuditActorClaim = 'email'

    public readonly AllowedHosts: HostAllowList
    public readonly TrustedProxy: boolean
    public readonly ApiPrefix: string
    public readonly DefaultBodyLimit: number
    public readonly AuditActorClaim: string
    public readonly Security: SecurityHeaders

    public constructor(options: AppHostConfigOptions = {})
    {
        this.AllowedHosts = HostAllowList.WithLoopback(options.AllowedHosts ?? [])
        this.TrustedProxy = options.TrustedProxy ?? false
        this.ApiPrefix = options.ApiPrefix ?? AppHostConfig.DefaultApiPrefix
        this.DefaultBodyLimit = options.DefaultBodyLimit ?? AppHostConfig.DefaultBodyLimit
        this.AuditActorClaim = options.AuditActorClaim ?? AppHostConfig.DefaultAuditActorClaim
        this.Security = new SecurityHeaders(options.Security)
    }
}
