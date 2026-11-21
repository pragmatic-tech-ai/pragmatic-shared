import { randomBytes } from 'node:crypto'

/** Secrets sealed at rest, by reference (the platform console's SealedSecretStore). */
export interface ISealedSecrets
{
    Get(ref: string): Promise<Buffer | undefined>
    Put(ref: string, value: Buffer): Promise<void>
    Delete(ref: string): Promise<void>
}

/** Per-hive 32-byte console fingerprint keys, sealed under the master key. */
export class ConsoleFingerprintKeys
{
    public static readonly KeyBytes = 32
    private static readonly RefPrefix = 'console-fingerprint-key/'

    private readonly pending = new Map<string, Promise<Buffer>>()

    public constructor(private readonly store: ISealedSecrets)
    {
    }

    public static RefOf(hiveId: string): string
    {
        return `${ConsoleFingerprintKeys.RefPrefix}${hiveId}`
    }

    /** Returns the existing key, else stores 32 fresh random bytes first. Concurrent calls share one key. */
    public Ensure(hiveId: string): Promise<Buffer>
    {
        const inflight = this.pending.get(hiveId)
        if (inflight !== undefined)
        {
            return inflight
        }
        const created = this.EnsureCore(hiveId).finally(() => this.pending.delete(hiveId))
        this.pending.set(hiveId, created)
        return created
    }

    public async Get(hiveId: string): Promise<Buffer | undefined>
    {
        return this.store.Get(ConsoleFingerprintKeys.RefOf(hiveId))
    }

    public async Remove(hiveId: string): Promise<void>
    {
        await this.store.Delete(ConsoleFingerprintKeys.RefOf(hiveId))
    }

    private async EnsureCore(hiveId: string): Promise<Buffer>
    {
        const existing = await this.Get(hiveId)
        if (existing !== undefined)
        {
            return existing
        }
        const key = randomBytes(ConsoleFingerprintKeys.KeyBytes)
        await this.store.Put(ConsoleFingerprintKeys.RefOf(hiveId), key)
        return key
    }
}
