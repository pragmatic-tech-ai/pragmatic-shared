/**
 * The start of a federated sign-in (accounts:createAuthUri): where to send the browser (the provider's authorization
 * URL, which returns the browser to the continue URI) and the Identity Platform session that must accompany the
 * provider's answer in accounts:signInWithIdp. The page keeps SessionId across the round trip (e.g. sessionStorage).
 */
export class IdentityPlatformAuthUri
{
    public constructor(
        public readonly AuthUri: string,
        public readonly SessionId: string,
        public readonly ProviderId: string)
    {
    }
}
