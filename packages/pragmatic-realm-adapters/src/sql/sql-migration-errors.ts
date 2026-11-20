/** A module's migration list is malformed (no name, or versions that are not exactly 1..n). */
export class SqlMigrationDefinitionError extends Error
{
    public constructor(public readonly Module: string, reason: string)
    {
        super(`migration module "${Module}": ${reason}`)
        this.name = SqlMigrationDefinitionError.name
    }
}

/** An applied migration's recorded checksum differs from the code's: the step was edited after it ran. */
export class SqlMigrationChecksumError extends Error
{
    public constructor(public readonly Module: string, public readonly Version: number)
    {
        super(`migration ${Module} v${Version} was changed after it was applied (checksum mismatch)`)
        this.name = SqlMigrationChecksumError.name
    }
}

/** The database holds a version the code does not know: older code started against a newer schema. */
export class SqlMigrationDowngradeError extends Error
{
    public constructor(public readonly Module: string, public readonly AppliedVersion: number, public readonly KnownVersion: number)
    {
        super(`migration module ${Module} is at v${AppliedVersion} but this code knows only up to v${KnownVersion} (downgrade refused)`)
        this.name = SqlMigrationDowngradeError.name
    }
}

/** The session cannot run transactions; migrations are applied one transaction each. */
export class SqlMigrationTransactionRequiredError extends Error
{
    public constructor(public readonly Module: string)
    {
        super(`migration module ${Module}: the SQL session does not support transactions`)
        this.name = SqlMigrationTransactionRequiredError.name
    }
}
