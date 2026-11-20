import { spawnSync } from 'node:child_process';

/** The outcome of one npm command. */
export interface IProcessResult
{
    Status: number | null;
    Stdout: string;
}

/** Runs an npm command; the seam the publisher's tests replace. */
export interface IProcessRunner
{
    Run(args: string[], cwd: string, inheritOutput: boolean): IProcessResult;
}

/**
 * Runs npm through the shell: npm is a shell script (npm.cmd on Windows). Every argument is quoted; the command itself
 * stays unquoted — a quoted "npm" breaks npm.cmd's own path resolution on Windows.
 */
export class NpmProcessRunner implements IProcessRunner
{
    private static readonly Npm = 'npm';
    private static readonly Utf8 = 'utf8';
    private static readonly Quote = '"';
    private static readonly Space = ' ';
    private static readonly Inherit = 'inherit';
    private static readonly Pipe = 'pipe';

    public Run(args: string[], cwd: string, inheritOutput: boolean): IProcessResult
    {
        const stdio = inheritOutput ? NpmProcessRunner.Inherit : NpmProcessRunner.Pipe;
        const result = spawnSync(NpmProcessRunner.CommandLine(args), { cwd, encoding: NpmProcessRunner.Utf8, shell: true, stdio });
        return { Status: result.status, Stdout: result.stdout ?? '' };
    }

    public static CommandLine(args: string[]): string
    {
        return [NpmProcessRunner.Npm, ...args.map(arg => NpmProcessRunner.Quote + arg + NpmProcessRunner.Quote)].join(NpmProcessRunner.Space);
    }
}
