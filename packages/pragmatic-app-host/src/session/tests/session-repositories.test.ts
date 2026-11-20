import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { InMemorySessionRepository } from '../session-repository.js'
import { SqlSessionRepository } from '../sql-session-repository.js'
import { SessionRepositoryConformance } from '../../tests/support/session-repository-conformance.js'

SessionRepositoryConformance.Register('InMemorySessionRepository', () => Promise.resolve(new InMemorySessionRepository()))

SqlTestSessions.Describe('SqlSessionRepository', (makeSession, backend) =>
{
    SessionRepositoryConformance.Register(backend, async () => await SqlSessionRepository.Open(await makeSession()))

    test(`${backend}: a session survives a restart (another repository over the same database)`, async () =>
    {
        const session = await makeSession()
        const record = SessionRepositoryConformance.Record('id-1', 'alice')
        await (await SqlSessionRepository.Open(session)).Insert(record)
        assert.deepEqual(await (await SqlSessionRepository.Open(session)).Find('id-1'), record)
    })
})

SqlTestSessions.DescribeLive('SqlSessionRepository', makeDatabase =>
{
    test('SqlSessionRepository [live]: a failed ReplaceSubject leaves every session as it was', async () =>
    {
        const database = await makeDatabase()
        const repository = await SqlSessionRepository.Open(database.Session())
        await repository.Insert(SessionRepositoryConformance.Record('a1', 'alice'))
        await repository.Insert(SessionRepositoryConformance.Record('b1', 'bob'))
        // The fresh record collides with bob's id, so the insert fails after the delete ran: the transaction rolls back.
        await assert.rejects(repository.ReplaceSubject('alice', SessionRepositoryConformance.Record('b1', 'alice')))
        assert.notEqual(await repository.Find('a1'), null)
        await database.Dispose()
    })
})
