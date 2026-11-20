import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { IdentityPlatformProvider } from "../client/identity-platform-provider.js";

/** The claims of a fake Identity Platform ID token; absent fields take the defaults of a verified password account. */
export interface FakeIdTokenClaims
{
    Uid: string;
    Email?: string | null;
    EmailVerified?: boolean;
    Name?: string;
    SignInProvider?: string;
    /** Seconds since the epoch; default: the issue time. */
    AuthTime?: number;
    Tenant?: string;
    /** Raw claims merged last (overrides included), to mint malformed tokens. */
    Extra?: Record<string, unknown>;
}

export interface FakeMintOptions
{
    Issuer?: string;
    Audience?: string;
    Kid?: string;
    /** Seconds since the epoch; default: now. */
    IssuedAt?: number;
    /** Seconds since the epoch; default: one hour after the issue time. */
    ExpiresAt?: number;
    /** Sign with a key the JWKS does not publish (under the published kid). */
    ForeignKey?: boolean;
    /** Leave the exp claim out. */
    NoExpiry?: boolean;
}

/**
 * A fake Google Identity Platform for tests: an RS256 key pair published as the securetoken JWKS, and ID tokens minted
 * the way Identity Platform mints them (iss https://securetoken.google.com/<project>, aud <project>, sub = uid,
 * firebase.sign_in_provider). Pair it with FakeIdentityPlatformHttp (the JWKS endpoint) and FakeIdentityPlatformRest
 * (the identitytoolkit REST endpoints).
 */
export class FakeIdentityPlatform
{
    public static readonly DefaultProjectId = "fake-identity-project";
    public static readonly SecuretokenJwksUri = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

    private static readonly IssuerPrefix = "https://securetoken.google.com/";
    private static readonly SigAlg = "RS256";
    private static readonly SigUse = "sig";
    private static readonly KidPrefix = "fake-securetoken-";
    private static readonly MillisPerSecond = 1000;
    private static readonly LifetimeSeconds = 3600;
    private static readonly EmailClaim = "email";
    private static readonly EmailVerifiedClaim = "email_verified";
    private static readonly NameClaim = "name";
    private static readonly AuthTimeClaim = "auth_time";
    private static readonly UserIdClaim = "user_id";
    private static readonly FirebaseClaim = "firebase";
    private static readonly SignInProviderField = "sign_in_provider";
    private static readonly TenantField = "tenant";
    private static readonly IdentitiesField = "identities";
    private static readonly ExampleDomain = "@example.test";

    private keyNumber = 0;
    private privateKey!: CryptoKey;
    private publicJwk!: JWK;
    private kid = "";

    private constructor(public readonly ProjectId: string)
    {
    }

    public get Issuer(): string
    {
        return FakeIdentityPlatform.IssuerPrefix + this.ProjectId;
    }

    public get CurrentKid(): string
    {
        return this.kid;
    }

    public static async Create(projectId?: string): Promise<FakeIdentityPlatform>
    {
        const platform = new FakeIdentityPlatform(projectId ?? FakeIdentityPlatform.DefaultProjectId);
        await platform.RotateKey();
        return platform;
    }

    /** Replaces the signing key (new kid); the old key leaves the JWKS, as after Google's rotation. */
    public async RotateKey(): Promise<void>
    {
        const { publicKey, privateKey } = await generateKeyPair(FakeIdentityPlatform.SigAlg);
        this.keyNumber++;
        this.kid = FakeIdentityPlatform.KidPrefix + this.keyNumber;
        const jwk = await exportJWK(publicKey);
        jwk.kid = this.kid;
        jwk.alg = FakeIdentityPlatform.SigAlg;
        jwk.use = FakeIdentityPlatform.SigUse;
        this.privateKey = privateKey;
        this.publicJwk = jwk;
    }

    public Jwks(): { keys: JWK[] }
    {
        return { keys: [this.publicJwk] };
    }

    public async MintIdToken(claims: FakeIdTokenClaims, opts?: FakeMintOptions): Promise<string>
    {
        const iat = opts?.IssuedAt ?? Math.floor(Date.now() / FakeIdentityPlatform.MillisPerSecond);
        const provider = claims.SignInProvider ?? IdentityPlatformProvider.Password;
        const firebase: Record<string, unknown> = { [FakeIdentityPlatform.SignInProviderField]: provider, [FakeIdentityPlatform.IdentitiesField]: {} };
        if (claims.Tenant !== undefined)
        {
            firebase[FakeIdentityPlatform.TenantField] = claims.Tenant;
        }
        const payload: Record<string, unknown> = {
            [FakeIdentityPlatform.UserIdClaim]: claims.Uid,
            [FakeIdentityPlatform.AuthTimeClaim]: claims.AuthTime ?? iat,
            [FakeIdentityPlatform.FirebaseClaim]: firebase,
        };
        if (claims.Email !== null)
        {
            payload[FakeIdentityPlatform.EmailClaim] = claims.Email ?? claims.Uid + FakeIdentityPlatform.ExampleDomain;
            payload[FakeIdentityPlatform.EmailVerifiedClaim] = claims.EmailVerified ?? true;
        }
        if (claims.Name !== undefined)
        {
            payload[FakeIdentityPlatform.NameClaim] = claims.Name;
        }
        Object.assign(payload, claims.Extra ?? {});
        const jwt = new SignJWT(payload)
            .setProtectedHeader({ alg: FakeIdentityPlatform.SigAlg, kid: opts?.Kid ?? this.kid })
            .setIssuer(opts?.Issuer ?? this.Issuer)
            .setAudience(opts?.Audience ?? this.ProjectId)
            .setIssuedAt(iat);
        if (claims.Uid !== "")
        {
            jwt.setSubject(claims.Uid);
        }
        if (opts?.NoExpiry !== true)
        {
            jwt.setExpirationTime(opts?.ExpiresAt ?? iat + FakeIdentityPlatform.LifetimeSeconds);
        }
        const key = opts?.ForeignKey === true ? (await generateKeyPair(FakeIdentityPlatform.SigAlg)).privateKey : this.privateKey;
        return await jwt.sign(key);
    }
}
