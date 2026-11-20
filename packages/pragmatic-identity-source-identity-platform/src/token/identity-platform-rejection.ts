/** Why an Identity Platform ID token was refused. */
export enum IdentityPlatformRejection
{
    Malformed = "malformed",
    WrongAlgorithm = "wrong-algorithm",
    UnknownKey = "unknown-key",
    KeysUnavailable = "keys-unavailable",
    BadSignature = "bad-signature",
    WrongIssuer = "wrong-issuer",
    WrongAudience = "wrong-audience",
    Expired = "expired",
    IssuedInFuture = "issued-in-future",
    AuthTimeInFuture = "auth-time-in-future",
    SignInTooOld = "sign-in-too-old",
    NoSubject = "no-subject",
    ProviderNotEnabled = "provider-not-enabled",
    WrongTenant = "wrong-tenant",
    EmailNotVerified = "email-not-verified",
}
