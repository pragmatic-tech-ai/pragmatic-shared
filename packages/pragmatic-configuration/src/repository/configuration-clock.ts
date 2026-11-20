/** Stamps configuration versions and apply records. */
export interface IConfigurationClock
{
    Now(): Date;
}

/** The system clock. */
export class SystemConfigurationClock implements IConfigurationClock
{
    public Now(): Date
    {
        return new Date();
    }
}
