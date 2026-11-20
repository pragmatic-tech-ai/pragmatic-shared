import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

/** Records every module specifier resolved after it is installed, so a test can tell what an import pulled in. */
class ResolvedSpecifiers
{
    private readonly seen: string[] = []

    public Install(): void
    {
        registerHooks({
            resolve: (specifier, context, next) =>
            {
                this.seen.push(specifier)
                return next(specifier, context)
            },
        })
    }

    public Includes(specifier: string): boolean
    {
        return this.seen.includes(specifier)
    }
}

class RootEntry
{
    public static readonly Pg = 'pg'
    public static readonly PgConnectionString = 'pg-connection-string'
    public static readonly Path = '../index.js'
}

test('importing the package root loads neither pg nor pg-connection-string (a desktop consumer needs no Postgres)', async () =>
{
    const resolved = new ResolvedSpecifiers()
    resolved.Install()
    const root = await import(RootEntry.Path)
    assert.equal(typeof root.PostgresPoolFactory, 'function')
    assert.equal(resolved.Includes(RootEntry.Pg), false)
    assert.equal(resolved.Includes(RootEntry.PgConnectionString), false)
})
