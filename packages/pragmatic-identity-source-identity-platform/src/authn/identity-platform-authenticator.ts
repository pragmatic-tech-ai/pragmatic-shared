import { AuditEvent, AuditEventKind, AuthMethod, AuthenticatedResult, RejectedResult } from "@pragmatic-tech-ai/pragmatic-identity";
import type { AuthenticationResult, Credential, IAuditSink, IAuthenticator, PresentedSecret, Realm } from "@pragmatic-tech-ai/pragmatic-identity";
import type { OidcDirectory } from "@pragmatic-tech-ai/pragmatic-identity-source-oidc";
import type { IdentityPlatformAccountMapper } from "../account/identity-platform-account-mapper.js";
import { IdentityPlatformRejection } from "../token/identity-platform-rejection.js";
import type { IdentityPlatformTokenVerifier } from "../token/identity-platform-token-verifier.js";

/**
 * Signs a person in from the Identity Platform ID token the login page posts (the presented secret; the credential
 * reference is unused). The token is an OIDC ID token from a trusted upstream, hence AuthMethod.Oidc. Failures carry
 * one generic reason, except an unverified email: the token proves the password, so saying so enumerates nothing and
 * lets the page offer to resend the verification email.
 */
export class IdentityPlatformAuthenticator implements IAuthenticator
{
    public static readonly RejectionReason = "authentication failed";
    public static readonly UnverifiedEmailReason = "email not verified";

    private static readonly MethodDetailKey = "method";
    private static readonly MethodValue = "identity-platform";
    private static readonly ProviderDetailKey = "provider";

    public readonly Method = AuthMethod.Oidc;

    public constructor(
        private readonly verifier: IdentityPlatformTokenVerifier,
        private readonly mapper: IdentityPlatformAccountMapper,
        private readonly directory: OidcDirectory,
        private readonly audit: IAuditSink,
        private readonly now: () => Date = () => new Date())
    {
    }

    public async Authenticate(_credential: Credential, presented: PresentedSecret, realm: Realm): Promise<AuthenticationResult>
    {
        const verification = await this.verifier.Verify(presented.Reveal());
        if (verification.Token === null)
        {
            return new RejectedResult(verification.Rejection === IdentityPlatformRejection.EmailNotVerified
                ? IdentityPlatformAuthenticator.UnverifiedEmailReason
                : IdentityPlatformAuthenticator.RejectionReason);
        }
        const principal = this.mapper.Map(verification.Token, realm);
        this.directory.Remember(principal);
        const detail = new Map([
            [IdentityPlatformAuthenticator.MethodDetailKey, IdentityPlatformAuthenticator.MethodValue],
            [IdentityPlatformAuthenticator.ProviderDetailKey, verification.Token.SignInProvider],
        ]);
        await this.audit.Record(new AuditEvent(AuditEventKind.Authentication, realm.Id, principal.Id, this.now(), detail));
        return new AuthenticatedResult(principal);
    }
}
