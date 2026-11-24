import { writeFileSync } from 'node:fs';

/**
 * How a component without a listener tells its readiness probe it has started: once its settings are read (after the
 * start step laid its configuration over its environment) it creates this file, and an exec probe tests for it
 * (`ProbeCommand`). A process that exits before that point is never ready, so a surge roll keeps the old pod.
 */
export class ComponentReadyFile
{
    /** Writable in every container (outside the read-only configuration and secret mounts). */
    public static readonly DefaultPath = '/tmp/pragmatic-ready';
    private static readonly TestProgram = 'test';
    private static readonly FileFlag = '-f';
    private static readonly NoText = '';

    public constructor(private readonly path: string = ComponentReadyFile.DefaultPath)
    {
    }

    /** The exec probe that passes once the default file exists. */
    public static ProbeCommand(): string[]
    {
        return new ComponentReadyFile().Command();
    }

    public Command(): string[]
    {
        return [ComponentReadyFile.TestProgram, ComponentReadyFile.FileFlag, this.path];
    }

    public Mark(): void
    {
        writeFileSync(this.path, ComponentReadyFile.NoText);
    }
}
