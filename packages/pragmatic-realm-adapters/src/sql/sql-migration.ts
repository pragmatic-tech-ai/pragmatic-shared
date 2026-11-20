import { createHash } from 'node:crypto'

/** One versioned schema step of a store module: SQL statements run in order inside one transaction. The checksum
 *  (sha256 over the statements, each terminated by ";\n") is recorded when the step is applied; editing an applied
 *  step changes it and the runner refuses to start. */
export class SqlMigration
{
    private static readonly HashAlgorithm = 'sha256'
    private static readonly Terminator = ';\n'
    private static readonly Digest = 'hex'

    public readonly Checksum: string

    public constructor(public readonly Version: number, public readonly Statements: readonly string[])
    {
        const hash = createHash(SqlMigration.HashAlgorithm)
        for (const statement of Statements)
        {
            hash.update(statement + SqlMigration.Terminator)
        }
        this.Checksum = hash.digest(SqlMigration.Digest)
    }
}

/** A named store module's schema history (e.g. "identity.accounts"): its migrations, versions 1..n. One subclass
 *  per store; the steps are its own constants, never a shared list. */
export abstract class SqlMigrationModule
{
    public abstract readonly Name: string

    public abstract Migrations(): readonly SqlMigration[]
}
