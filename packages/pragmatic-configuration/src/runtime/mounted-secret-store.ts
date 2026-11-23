import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity';

/**
 * A read-only secret store over a mounted directory: a secret is the file `<directory>/<name>` (a Kubernetes Secret
 * mounted as a volume, one key per file). The store `file` of a hive component is the Secret
 * `pragmatic-secrets-<component>` the tenant admin console writes, mounted at `/run/secrets/pragmatic/<component>`.
 * A name that is not one plain file name (a path separator, a leading dot) is never read, so a reference cannot
 * reach outside the directory; it answers absent, like a key the Secret does not hold.
 */
export class MountedSecretStore implements ISecretStore
{
    private static readonly NamePattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
    private static readonly NotFound = 'ENOENT';
    private static readonly Encoding = 'utf8';
    private static readonly ReadOnly = 'MountedSecretStore: the mounted secrets are read-only';
    private static readonly Unreadable = 'MountedSecretStore: cannot read a mounted secret:';

    public constructor(public readonly Directory: string)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        const S = MountedSecretStore;
        if (!S.NamePattern.test(reference)) return null;
        try
        {
            return await readFile(join(this.Directory, reference), S.Encoding);
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            if (code === S.NotFound) return null;
            throw new Error(`${S.Unreadable} ${String(code)}`);
        }
    }

    public Put(): Promise<void>
    {
        return Promise.reject(new Error(MountedSecretStore.ReadOnly));
    }

    public Delete(): Promise<void>
    {
        return Promise.reject(new Error(MountedSecretStore.ReadOnly));
    }
}
