import { decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { IdentityPlatformProvider } from "../client/identity-platform-provider.js";
import type { IdentityPlatformSettings } from "../settings/identity-platform-settings.js";
import type { IdentityPlatformKeyResolver, IdentityPlatformKeySet } from "./identity-platform-key-set.js";
import { IdentityPlatformRejection } from "./identity-platform-rejection.js";
import { IdentityPlatformToken } from "./identity-platform-token.js";
import { IdentityPlatformVerification } from "./identity-platform-verification.js";

/**
 * Verifies an Identity Platform ID token the way Google documents it for third-party verification: RS256 under a
 * current securetoken key, iss https://securetoken.google.com/<project>, aud <project>, exp in the future, iat and
 * auth_time in the past, a non-empty sub (the uid). On top: the sign-in must be recent (auth_time within the maximum
 * age), its provider enabled for the realm (never anonymous), the Identity Platform tenant the configured one, and a
 * password account's email verified. Fail-closed: anything unexpected is a rejection, never a throw.
 */
export class IdentityPlatformTokenVerifier
{
    private static readonly Algorithm = "RS256";
    private static readonly ClockToleranceSeconds = 60;
    private static readonly MillisPerSecond = 1000;
    private static readonly MaxSubjectLength = 128;
    private static readonly NoMatchingKeyCode = "ERR_JWKS_NO_MATCHING_KEY";
    private static readonly ExpiredCode = "ERR_JWT_EXPIRED";
    private static readonly BadSignatureCode = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
    private static readonly AuthTimeClaim = "auth_time";
    private static readonly EmailClaim = "email";
    private static readonly EmailVerifiedClaim = "email_verified";
    private static readonly NameClaim = "name";
    private static readonly FirebaseClaim = "firebase";
    private static readonly SignInProviderField = "sign_in_provider";
    private static readonly TenantField = "tenant";
    private static readonly NumberType = "number";
    private static readonly StringType = "string";

    public constructor(
        private readonly settings: IdentityPlatformSettings,
        private readonly keys: IdentityPlatformKeySet,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Verify(idToken: string): Promise<IdentityPlatformVerification>
    {
        const headerRejection = this.CheckHeader(idToken);
        if (headerRejection !== null)
        {
            return IdentityPlatformVerification.Rejected(headerRejection);
        }
        const verified = await this.VerifySignature(idToken);
        if (typeof verified === IdentityPlatformTokenVerifier.StringType)
        {
            return IdentityPlatformVerification.Rejected(verified as IdentityPlatformRejection);
        }
        return this.CheckClaims(verified as JWTPayload);
    }

    private CheckHeader(idToken: string): IdentityPlatformRejection | null
    {
        try
        {
            const header = decodeProtectedHeader(idToken);
            if (header.alg !== IdentityPlatformTokenVerifier.Algorithm)
            {
                return IdentityPlatformRejection.WrongAlgorithm;
            }
            if (typeof header.kid !== IdentityPlatformTokenVerifier.StringType || header.kid === "")
            {
                return IdentityPlatformRejection.UnknownKey;
            }
            return null;
        }
        catch
        {
            return IdentityPlatformRejection.Malformed;
        }
    }

    private async VerifySignature(idToken: string): Promise<JWTPayload | IdentityPlatformRejection>
    {
        let resolver: IdentityPlatformKeyResolver;
        try
        {
            resolver = await this.keys.Current();
        }
        catch
        {
            return IdentityPlatformRejection.KeysUnavailable;
        }
        const first = await this.TryVerify(idToken, resolver);
        if (first !== IdentityPlatformRejection.UnknownKey)
        {
            return first;
        }
        let refreshed: IdentityPlatformKeyResolver | null;
        try
        {
            refreshed = await this.keys.RefreshForUnknownKey();
        }
        catch
        {
            return IdentityPlatformRejection.KeysUnavailable;
        }
        return refreshed === null ? IdentityPlatformRejection.UnknownKey : this.TryVerify(idToken, refreshed);
    }

    private async TryVerify(idToken: string, resolver: IdentityPlatformKeyResolver): Promise<JWTPayload | IdentityPlatformRejection>
    {
        try
        {
            const { payload } = await jwtVerify(idToken, resolver, {
                algorithms: [IdentityPlatformTokenVerifier.Algorithm],
                currentDate: this.now(),
                clockTolerance: IdentityPlatformTokenVerifier.ClockToleranceSeconds,
            });
            return payload;
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            if (code === IdentityPlatformTokenVerifier.NoMatchingKeyCode)
            {
                return IdentityPlatformRejection.UnknownKey;
            }
            if (code === IdentityPlatformTokenVerifier.ExpiredCode)
            {
                return IdentityPlatformRejection.Expired;
            }
            if (code === IdentityPlatformTokenVerifier.BadSignatureCode)
            {
                return IdentityPlatformRejection.BadSignature;
            }
            return IdentityPlatformRejection.Malformed;
        }
    }

    private CheckClaims(payload: JWTPayload): IdentityPlatformVerification
    {
        const nowSeconds = this.now().getTime() / IdentityPlatformTokenVerifier.MillisPerSecond;
        const latest = nowSeconds + IdentityPlatformTokenVerifier.ClockToleranceSeconds;
        if (payload.iss !== this.settings.Issuer)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.WrongIssuer);
        }
        if (payload.aud !== this.settings.ProjectId)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.WrongAudience);
        }
        const authTime = payload[IdentityPlatformTokenVerifier.AuthTimeClaim];
        if (typeof payload.exp !== IdentityPlatformTokenVerifier.NumberType
            || typeof payload.iat !== IdentityPlatformTokenVerifier.NumberType
            || typeof authTime !== IdentityPlatformTokenVerifier.NumberType)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.Malformed);
        }
        if (payload.iat! > latest)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.IssuedInFuture);
        }
        if ((authTime as number) > latest)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.AuthTimeInFuture);
        }
        if (nowSeconds - (authTime as number) > this.settings.MaxAuthAgeSeconds)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.SignInTooOld);
        }
        const sub = payload.sub;
        if (typeof sub !== IdentityPlatformTokenVerifier.StringType || sub === "" || sub!.length > IdentityPlatformTokenVerifier.MaxSubjectLength)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.NoSubject);
        }
        const firebase = payload[IdentityPlatformTokenVerifier.FirebaseClaim] as Record<string, unknown> | undefined;
        const provider = firebase?.[IdentityPlatformTokenVerifier.SignInProviderField];
        if (typeof provider !== IdentityPlatformTokenVerifier.StringType)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.Malformed);
        }
        if (!this.settings.Enables(provider as string))
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.ProviderNotEnabled);
        }
        const tenant = firebase?.[IdentityPlatformTokenVerifier.TenantField];
        if ((tenant ?? null) !== this.settings.TenantId)
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.WrongTenant);
        }
        const email = payload[IdentityPlatformTokenVerifier.EmailClaim];
        const emailVerified = payload[IdentityPlatformTokenVerifier.EmailVerifiedClaim] === true;
        const hasEmail = typeof email === IdentityPlatformTokenVerifier.StringType && email !== "";
        if (provider === IdentityPlatformProvider.Password && (!hasEmail || !emailVerified))
        {
            return IdentityPlatformVerification.Rejected(IdentityPlatformRejection.EmailNotVerified);
        }
        const name = payload[IdentityPlatformTokenVerifier.NameClaim];
        return IdentityPlatformVerification.Verified(new IdentityPlatformToken(
            sub!,
            hasEmail ? email as string : null,
            emailVerified,
            typeof name === IdentityPlatformTokenVerifier.StringType && name !== "" ? name as string : null,
            provider as string,
            typeof tenant === IdentityPlatformTokenVerifier.StringType ? tenant as string : null,
            IdentityPlatformTokenVerifier.DateOf(authTime as number),
            IdentityPlatformTokenVerifier.DateOf(payload.iat!),
            IdentityPlatformTokenVerifier.DateOf(payload.exp!)));
    }

    private static DateOf(seconds: number): Date
    {
        return new Date(seconds * IdentityPlatformTokenVerifier.MillisPerSecond);
    }
}
