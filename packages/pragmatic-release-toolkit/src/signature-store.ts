/** Signatures per image digest, one per signing key ref: two keys signing the same digest never displace each other. */
export interface ISignatureStore
{
    Get(digest: string, keyRef: string): Promise<string | undefined>
    /** Whether `keyRef` itself filed a signature for `digest` (a pre-keyed entry never counts): what "signed with this key" reports. */
    HasKeyed(digest: string, keyRef: string): Promise<boolean>
    Put(digest: string, keyRef: string, signature: string): Promise<void>
}
