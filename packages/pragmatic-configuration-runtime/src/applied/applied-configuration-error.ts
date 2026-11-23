/** An applied-configuration object or file that cannot be built or read. Never carries document values. */
export class AppliedConfigurationError extends Error
{
    private static readonly Prefix = 'applied configuration';

    public constructor(reason: string)
    {
        super(`${AppliedConfigurationError.Prefix}: ${reason}`);
        this.name = AppliedConfigurationError.name;
    }
}
