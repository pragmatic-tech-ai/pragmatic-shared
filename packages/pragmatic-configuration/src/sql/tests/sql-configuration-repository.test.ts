import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing';
import { ConfigurationFixtures, TestClock } from '../../tests/fixtures/configuration-fixtures.js';
import { ApplyOutcome, ApplyRequest, ApplyTarget } from '../../repository/apply-record.js';
import { ConfigurationHeadMovedError } from '../../repository/configuration-repository-errors.js';
import { ConfigurationRepositoryConformance } from '../../repository/tests/configuration-repository-conformance.js';
import { SqlConfigurationRepository } from '../sql-configuration-repository.js';

SqlTestSessions.Describe('SqlConfigurationRepository', (makeSession, backend) =>
{
    ConfigurationRepositoryConformance.Register(backend, async clock => SqlConfigurationRepository.Open(await makeSession(), clock));

    test(`${backend}: versions and applies survive reopening the repository on the same database`, async () =>
    {
        const session = await makeSession();
        const scope = ConfigurationFixtures.Scope();
        const first = await SqlConfigurationRepository.Open(session, new TestClock());
        await first.Save(ConfigurationFixtures.Save(scope, 0));
        const record = await first.BeginApply(new ApplyRequest(scope, 1, new ApplyTarget('hive-one', 'realm-a', 'tenant-idp'), 'sub'));
        const reopened = await SqlConfigurationRepository.Open(session, new TestClock());
        assert.equal((await reopened.Head(scope))?.Number, 1);
        assert.equal((await reopened.CompleteApply(scope, record.Id, ApplyOutcome.Applied, '')).Outcome, ApplyOutcome.Applied);
    });
});

SqlTestSessions.DescribeLive('SqlConfigurationRepository', makeDatabase =>
{
    test('live: of concurrent saves based on the same head exactly one lands', async () =>
    {
        const database = await makeDatabase();
        try
        {
            const scope = ConfigurationFixtures.Scope();
            const repositories = await Promise.all([0, 1, 2, 3].map(() => SqlConfigurationRepository.Open(database.Session(), new TestClock())));
            await repositories[0].Save(ConfigurationFixtures.Save(scope, 0));
            const results = await Promise.allSettled(repositories.map(repository => repository.Save(ConfigurationFixtures.Save(scope, 1))));
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            for (const result of results)
            {
                if (result.status === 'rejected') assert.ok(result.reason instanceof ConfigurationHeadMovedError, String(result.reason));
            }
            assert.deepEqual((await repositories[0].Versions(scope)).map(version => version.Number), [1, 2]);
        }
        finally
        {
            await database.Dispose();
        }
    });

    test('live: concurrent applies get distinct ids', async () =>
    {
        const database = await makeDatabase();
        try
        {
            const scope = ConfigurationFixtures.Scope();
            const repositories = await Promise.all([0, 1, 2, 3].map(() => SqlConfigurationRepository.Open(database.Session(), new TestClock())));
            await repositories[0].Save(ConfigurationFixtures.Save(scope, 0));
            const target = new ApplyTarget('hive-one', 'realm-a', 'tenant-idp');
            const records = await Promise.all(repositories.map(repository => repository.BeginApply(new ApplyRequest(scope, 1, target, 'sub'))));
            assert.deepEqual(records.map(record => record.Id).sort(), [1, 2, 3, 4]);
        }
        finally
        {
            await database.Dispose();
        }
    });
});
