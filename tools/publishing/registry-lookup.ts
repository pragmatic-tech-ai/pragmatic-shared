import { IProcessRunner } from './process-runner.js';

/** Answers whether a `name@version` is on the registry; the seam the publisher's tests replace. */
export interface IRegistryLookup
{
    Exists(id: string): boolean;
}

/** `npm view <name@version> version` against one registry: published when it prints the version. */
export class NpmRegistryLookup implements IRegistryLookup
{
    private static readonly View = 'view';
    private static readonly VersionField = 'version';
    private static readonly RegistryFlag = '--registry';

    public constructor(private readonly runner: IProcessRunner, private readonly registry: string)
    {
    }

    public Exists(id: string): boolean
    {
        const result = this.runner.Run([NpmRegistryLookup.View, id, NpmRegistryLookup.VersionField, NpmRegistryLookup.RegistryFlag, this.registry], process.cwd(), false);
        return result.Status === 0 && result.Stdout.trim().length > 0;
    }
}
