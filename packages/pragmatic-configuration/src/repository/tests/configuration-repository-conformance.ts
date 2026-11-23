import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationErrorCode } from '@pragmatic-tech-ai/pragmatic-component';
import { ConfigurationFixtures, TestClock } from '../../tests/fixtures/configuration-fixtures.js';
import { ApplyOutcome, ApplyRequest, ApplyTarget } from '../apply-record.js';
import type { IConfigurationRepository } from '../configuration-repository.js';
import {
    ApplyOutcomeError,
    ApplyRecordNotFoundError,
    ConfigurationHeadMovedError,
    ConfigurationRejectedError,
    ConfigurationRequestError,
    ConfigurationVersionNotFoundError,
} from '../configuration-repository-errors.js';
import { ConfigurationSaveRequest } from '../configuration-save-request.js';
import { ConfigurationScope } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';

/** Opens a fresh, empty repository stamped by `clock`. */
export type RepositoryOpener = (clock: TestClock) => Promise<IConfigurationRepository>;

/** The behaviour every IConfigurationRepository shares; registered once per implementation (and backend). */
export class ConfigurationRepositoryConformance
{
    private static readonly Target = new ApplyTarget('hive-one', 'realm-a', 'tenant-idp');
    private static readonly OtherTarget = new ApplyTarget('hive-two', 'realm-a', 'tenant-idp');
    private static readonly Requester = 'sub-admin-2';

    public static Register(label: string, open: RepositoryOpener): void
    {
        const target = ConfigurationRepositoryConformance.Target;
        const requester = ConfigurationRepositoryConformance.Requester;

        test(`${label}: versions append in order with the descriptor they were validated against`, async () =>
        {
            const clock = new TestClock();
            const repository = await open(clock);
            const scope = ConfigurationFixtures.Scope();
            assert.equal(await repository.Head(scope), null);
            const first = await repository.Save(ConfigurationFixtures.Save(scope, 0));
            clock.Advance(60_000);
            const descriptor = ConfigurationFixtures.Descriptor('0.4.0');
            const second = await repository.Save(ConfigurationFixtures.Save(scope, 1, ConfigurationFixtures.Document(16), descriptor));
            assert.equal(first.Number, 1);
            assert.equal(second.Number, 2);
            assert.equal(second.ComponentVersion, '0.4.0');
            assert.equal(second.DescriptorDigest, descriptor.ContentDigest());
            assert.equal(first.DescriptorDigest, ConfigurationFixtures.Descriptor().ContentDigest());
            assert.equal(second.CreatedAt.getTime() - first.CreatedAt.getTime(), 60_000);
            const head = await repository.Head(scope);
            assert.equal(head?.Number, 2);
            assert.deepEqual(head?.Document, ConfigurationFixtures.Document(16));
            assert.equal(head?.Author, ConfigurationFixtures.Author);
            assert.equal(head?.Comment, 'edit on 1');
            assert.equal(head?.CreatedAt.getTime(), clock.Now().getTime());
            assert.deepEqual((await repository.Versions(scope)).map(version => version.Number), [1, 2]);
            assert.deepEqual((await repository.Version(scope, 1))?.Document, ConfigurationFixtures.Document());
            assert.equal(await repository.Version(scope, 3), null);
        });

        test(`${label}: the document is stored as authored (defaults are not filled in)`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            const document = { options: { local: {} } };
            await repository.Save(ConfigurationFixtures.Save(scope, 0, document));
            assert.deepEqual((await repository.Head(scope))?.Document, document);
        });

        test(`${label}: a save based on a version that is no longer the head fails`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            await repository.Save(ConfigurationFixtures.Save(scope, 0));
            await repository.Save(ConfigurationFixtures.Save(scope, 1));
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 1)), (error: unknown) =>
                error instanceof ConfigurationHeadMovedError && error.BasedOn === 1 && error.Head === 2);
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 0)), ConfigurationHeadMovedError);
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 5)), ConfigurationHeadMovedError);
            assert.equal((await repository.Versions(scope)).length, 2);
        });

        test(`${label}: an invalid document is rejected with every error; a literal secret is never echoed`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 0, ConfigurationFixtures.LiteralSecretDocument())), (error: unknown) =>
            {
                assert.ok(error instanceof ConfigurationRejectedError);
                assert.deepEqual(error.Errors.map(item => [item.Path, item.Code]), [['/options/google/clientSecret', ConfigurationErrorCode.LiteralSecret]]);
                assert.ok(!error.message.includes(ConfigurationFixtures.SecretValue));
                return true;
            });
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 0, { options: { local: { passwordMinLength: 'long' }, saml: {} } })), (error: unknown) =>
                error instanceof ConfigurationRejectedError && error.Errors.length === 2);
            assert.equal(await repository.Head(scope), null);
        });

        test(`${label}: a request with another component's descriptor, no author or a bad base fails`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope('tenant-admin');
            await assert.rejects(repository.Save(ConfigurationFixtures.Save(scope, 0)), ConfigurationRequestError);
            const own = ConfigurationFixtures.Scope();
            const descriptor = ConfigurationFixtures.Descriptor();
            await assert.rejects(repository.Save(new ConfigurationSaveRequest(own, 0, ConfigurationFixtures.Document(), descriptor, ' ', '')), ConfigurationRequestError);
            await assert.rejects(repository.Save(new ConfigurationSaveRequest(own, -1, ConfigurationFixtures.Document(), descriptor, 'sub', '')), ConfigurationRequestError);
            await assert.rejects(repository.Save(new ConfigurationSaveRequest(own, 0.5, ConfigurationFixtures.Document(), descriptor, 'sub', '')), ConfigurationRequestError);
        });

        test(`${label}: scopes are separate; Components lists a realm's configured components by name`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            const other = new ConfigurationScope(scope.Realm, 'aaa-first');
            const elsewhere = ConfigurationFixtures.Scope();
            await repository.Save(ConfigurationFixtures.Save(scope, 0));
            await repository.Save(new ConfigurationSaveRequest(other, 0, { options: {} }, ConfigurationFixtures.Descriptor('0.1.0', 'aaa-first'), 'sub', ''));
            await repository.Save(ConfigurationFixtures.Save(elsewhere, 0));
            assert.deepEqual(await repository.Components(scope.Realm), ['aaa-first', ConfigurationFixtures.Component]);
            assert.deepEqual(await repository.Components('realm-none'), []);
            assert.equal((await repository.Versions(other)).length, 1);
            assert.equal((await repository.Head(elsewhere))?.Number, 1);
        });

        test(`${label}: an apply is recorded pending, completed once, and the applied version is per target`, async () =>
        {
            const clock = new TestClock();
            const repository = await open(clock);
            const scope = ConfigurationFixtures.Scope();
            await repository.Save(ConfigurationFixtures.Save(scope, 0));
            await repository.Save(ConfigurationFixtures.Save(scope, 1));
            const first = await repository.BeginApply(new ApplyRequest(scope, 1, target, requester));
            assert.equal(first.Id, 1);
            assert.equal(first.Outcome, ApplyOutcome.Pending);
            assert.equal(first.CompletedAt, undefined);
            assert.equal(await repository.Applied(scope, target), null);
            clock.Advance(5_000);
            const done = await repository.CompleteApply(scope, first.Id, ApplyOutcome.Applied, '');
            assert.equal(done.Outcome, ApplyOutcome.Applied);
            assert.equal(done.CompletedAt?.getTime(), clock.Now().getTime());
            assert.equal(done.RequestedAt.getTime(), clock.Now().getTime() - 5_000);
            await assert.rejects(repository.CompleteApply(scope, first.Id, ApplyOutcome.Failed, 'again'), ApplyOutcomeError);
            const second = await repository.BeginApply(new ApplyRequest(scope, 2, target, requester));
            await repository.CompleteApply(scope, second.Id, ApplyOutcome.Failed, 'rollout timed out');
            const applied = await repository.Applied(scope, target);
            assert.equal(applied?.Version, 1);
            assert.equal(applied?.RequestedBy, requester);
            assert.ok(applied?.Target.Equals(target));
            assert.equal(await repository.Applied(scope, ConfigurationRepositoryConformance.OtherTarget), null);
            const third = await repository.BeginApply(new ApplyRequest(scope, 2, target, requester));
            await repository.CompleteApply(scope, third.Id, ApplyOutcome.Applied, 'rolled');
            assert.equal((await repository.Applied(scope, target))?.Version, 2);
            const applies = await repository.Applies(scope);
            assert.deepEqual(applies.map(record => [record.Id, record.Version, record.Outcome, record.Detail]), [
                [1, 1, ApplyOutcome.Applied, ''],
                [2, 2, ApplyOutcome.Failed, 'rollout timed out'],
                [3, 2, ApplyOutcome.Applied, 'rolled'],
            ]);
        });

        test(`${label}: an apply of an unknown version, an unknown apply or a pending outcome fails`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            await assert.rejects(repository.BeginApply(new ApplyRequest(scope, 1, target, requester)), ConfigurationVersionNotFoundError);
            await repository.Save(ConfigurationFixtures.Save(scope, 0));
            await assert.rejects(repository.BeginApply(new ApplyRequest(scope, 0, target, requester)), ConfigurationRequestError);
            await assert.rejects(repository.BeginApply(new ApplyRequest(scope, 1, target, '')), ConfigurationRequestError);
            await assert.rejects(repository.CompleteApply(scope, 9, ApplyOutcome.Applied, ''), ApplyRecordNotFoundError);
            const record = await repository.BeginApply(new ApplyRequest(scope, 1, target, requester));
            await assert.rejects(repository.CompleteApply(scope, record.Id, ApplyOutcome.Pending, ''), ApplyOutcomeError);
            assert.equal((await repository.Applies(ConfigurationFixtures.Scope())).length, 0);
        });

        test(`${label}: reads hand out copies`, async () =>
        {
            const repository = await open(new TestClock());
            const scope = ConfigurationFixtures.Scope();
            const document = ConfigurationFixtures.Document();
            await repository.Save(ConfigurationFixtures.Save(scope, 0, document));
            (document.options as Record<string, unknown>).local = { passwordMinLength: 99 };
            const head = await repository.Head(scope);
            (head!.Document.options as Record<string, unknown>).local = { passwordMinLength: 98 };
            assert.deepEqual((await repository.Head(scope))?.Document, ConfigurationFixtures.Document());
        });
    }
}
