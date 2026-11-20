import { DelegationDepth } from "@pragmatic-tech-ai/pragmatic-identity";
import type { AuthMethod, IAccessPolicy, IAuditSink, IAuthenticator, IdentityConfig, IIdentityProviderPack, IPrincipalDirectory, IRoleGrantStore, ISessionManager } from "@pragmatic-tech-ai/pragmatic-identity";
import { ClaimsAccessPolicy, FetchHttpClient, OidcDirectory } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import type { IHttpClient } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import { IdentityPlatformAccountMapper } from "../account/identity-platform-account-mapper.js";
import { IdentityPlatformAuthenticator } from "../authn/identity-platform-authenticator.js";
import { IdentityPlatformSettings } from "../settings/identity-platform-settings.js";
import { IdentityPlatformKeySet } from "../token/identity-platform-key-set.js";
import { IdentityPlatformTokenVerifier } from "../token/identity-platform-token-verifier.js";
import { IdentityPlatformClientConfig } from "./identity-platform-client-config.js";

export interface IdentityPlatformPackOptions
{
    Config: IdentityConfig;
    /** For the securetoken JWKS; default FetchHttpClient (https only). */
    Http?: IHttpClient;
    Sessions: ISessionManager;
    Grants: IRoleGrantStore;
    Audit: IAuditSink;
    now?: () => Date;
}

/**
 * Google Identity Platform as an identity source of a realm (the central realm's accounts: email + password with a
 * verified email; Google accounts once the owner's OAuth client is configured). The login page signs the person in
 * with Identity Platform (./client) and posts the ID token; the authenticator verifies it and maps it to the realm
 * account. ClientConfig is what the page needs.
 *
 * PR7: no directory API here; an account disabled in Identity Platform keeps access until its session expires.
 */
export class IdentityPlatformPack implements IIdentityProviderPack
{
    public readonly DelegationDepth: DelegationDepth;
    public readonly Authenticators: readonly IAuthenticator[];
    public readonly Directory: IPrincipalDirectory;
    public readonly Sessions: ISessionManager;
    public readonly Grants: IRoleGrantStore;
    public readonly Policy?: IAccessPolicy;
    public readonly Audit: IAuditSink;
    public readonly Settings: IdentityPlatformSettings;
    public readonly ClientConfig: IdentityPlatformClientConfig;
    public readonly Verifier: IdentityPlatformTokenVerifier;

    private constructor(opts: IdentityPlatformPackOptions)
    {
        const now = opts.now ?? (() => new Date());
        this.Settings = IdentityPlatformSettings.From(opts.Config.ProviderSettings);
        this.ClientConfig = IdentityPlatformClientConfig.From(this.Settings);
        this.Verifier = new IdentityPlatformTokenVerifier(this.Settings, new IdentityPlatformKeySet(opts.Http ?? new FetchHttpClient(), now), now);
        const directory = new OidcDirectory();
        this.Directory = directory;
        this.Authenticators = [new IdentityPlatformAuthenticator(this.Verifier, new IdentityPlatformAccountMapper(), directory, opts.Audit, now)];
        this.DelegationDepth = opts.Config.DelegationDepth;
        this.Sessions = opts.Sessions;
        this.Grants = opts.Grants;
        this.Audit = opts.Audit;
        this.Policy = opts.Config.DelegationDepth === DelegationDepth.FullAuthz ? new ClaimsAccessPolicy(opts.Config.GroupRoleMap) : undefined;
    }

    public static Create(opts: IdentityPlatformPackOptions): IdentityPlatformPack
    {
        return new IdentityPlatformPack(opts);
    }

    public AuthenticatorFor(method: AuthMethod): IAuthenticator | undefined
    {
        return this.Authenticators.find(authenticator => authenticator.Method === method);
    }
}
