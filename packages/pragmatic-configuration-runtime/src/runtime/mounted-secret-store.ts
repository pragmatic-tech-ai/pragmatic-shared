import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import type { ISecretSource } from './secret-store-directory.js';

/**
 * A read-only secret store over a mounted directory: a secret is the file `<directory>/<name>` (a Kubernetes Secret
 * mounted as a volume, one key per file). The store `file` of a hive component is the Secret
 * `pragmatic-secrets-<component>` the tenant admin console writes, mounted at `/run/secrets/pragmatic/<component>`.
 * A name that is not one plain file name (a path separator, a leading dot) is never read, so a reference cannot
 * reach outside the directory; it answers absent, like a key the Secret does not hold. A Secret key has no versions, so a
 * pinned reference (`secret:file/<name>@<version>`) is refused as such. One trailing line break of a file is dropped (the
 * same rule `SecretVariable` reads a file by): a key written from a file usually ends with one.
 */
export class MountedSecretStore implements ISecretSource
{
    private static readonly NamePattern = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
    private static readonly NotFound = 'ENOENT';
    private static readonly Encoding = 'utf8';
    private static readonly ReadOnly = 'MountedSecretStore: the mounted secrets are read-only';
    private static readonly Unreadable = 'MountedSecretStore: cannot read a mounted secret:';
    private static readonly VersionSeparator = '@';
    private static readonly Unversioned = 'a mounted secret store holds no versions; refer to it without @<version>:';
    private static readonly TrailingLineBreak = /\r?\n$/;

    public constructor(public readonly Directory: string)
    {
    }

    public async Get(reference: string): Promise<string | null>
    {
        const S = MountedSecretStore;
        if (reference.includes(S.VersionSeparator))
        {
            throw new ConfigurationStartError(ConfigurationStartReason.SecretUnreadable, `${S.Unversioned} ${reference.slice(0, reference.indexOf(S.VersionSeparator))}`);
        }
        if (!S.NamePattern.test(reference)) return null;
        try
        {
            return (await readFile(join(this.Directory, reference), S.Encoding)).replace(S.TrailingLineBreak, '');
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
