import type { ConfigurationError } from '@pragmatic-tech-ai/pragmatic-component';
import type { ConfigurationScope } from './configuration-scope.js';

/** The document does not fit the descriptor of the container version it is saved for. Lists paths and fixed messages,
 *  never the rejected values (a literal secret must not reach a log through this error). */
export class ConfigurationRejectedError extends Error
{
    private static readonly Prefix = 'configuration rejected for';
    private static readonly Separator = '; ';

    public readonly Errors: readonly ConfigurationError[];

    public constructor(public readonly Scope: ConfigurationScope, errors: readonly ConfigurationError[])
    {
        super(`${ConfigurationRejectedError.Prefix} ${Scope.Key()}: ${errors.map(error => error.toString()).join(ConfigurationRejectedError.Separator)}`);
        this.name = ConfigurationRejectedError.name;
        this.Errors = Object.freeze([...errors]);
    }
}

/** A new version was based on a version that is no longer the head (someone saved in between). */
export class ConfigurationHeadMovedError extends Error
{
    public constructor(public readonly Scope: ConfigurationScope, public readonly BasedOn: number, public readonly Head: number)
    {
        super(`configuration ${Scope.Key()} is at version ${Head}, not ${BasedOn}: reload and save again`);
        this.name = ConfigurationHeadMovedError.name;
    }
}

/** The request breaks a rule of its own (a descriptor of another component, no author, a bad version number). */
export class ConfigurationRequestError extends Error
{
    public constructor(public readonly Scope: ConfigurationScope, reason: string)
    {
        super(`configuration ${Scope.Key()}: ${reason}`);
        this.name = ConfigurationRequestError.name;
    }
}

/** No such configuration version in the scope. */
export class ConfigurationVersionNotFoundError extends Error
{
    public constructor(public readonly Scope: ConfigurationScope, public readonly Version: number)
    {
        super(`configuration ${Scope.Key()} has no version ${Version}`);
        this.name = ConfigurationVersionNotFoundError.name;
    }
}

/** No such apply record in the scope. */
export class ApplyRecordNotFoundError extends Error
{
    public constructor(public readonly Scope: ConfigurationScope, public readonly Id: number)
    {
        super(`configuration ${Scope.Key()} has no apply ${Id}`);
        this.name = ApplyRecordNotFoundError.name;
    }
}

/** An apply's outcome is recorded once, as applied or failed; this one is already recorded, or the outcome is pending. */
export class ApplyOutcomeError extends Error
{
    public constructor(public readonly Scope: ConfigurationScope, public readonly Id: number, reason: string)
    {
        super(`configuration ${Scope.Key()} apply ${Id}: ${reason}`);
        this.name = ApplyOutcomeError.name;
    }
}
