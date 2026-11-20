import { ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import type { JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import { ApplyOutcome } from './apply-record.js';
import type { ApplyRecord, ApplyRequest } from './apply-record.js';
import { ApplyOutcomeError, ConfigurationHeadMovedError, ConfigurationRejectedError, ConfigurationRequestError } from './configuration-repository-errors.js';
import type { ConfigurationSaveRequest } from './configuration-save-request.js';
import { ConfigurationVersion } from './configuration-version.js';

/** The rules every repository implementation applies the same way: what a valid save, apply and outcome are. */
export class ConfigurationAuthoring
{
    private static readonly OtherComponent = 'the descriptor is of another component';
    private static readonly NoAuthor = 'a configuration version needs an author';
    private static readonly NoRequester = 'an apply needs a requester';
    private static readonly BadBase = 'BasedOn is a version number (0 for the first version)';
    private static readonly BadVersion = 'a version number is a positive integer';
    private static readonly PendingOutcome = 'an apply completes as applied or failed';
    private static readonly AlreadyCompleted = 'the outcome is already recorded';

    /** Checks the request (its own rules, then the head, then the document) and builds version head + 1. */
    public static Prepare(request: ConfigurationSaveRequest, head: number, createdAt: Date): ConfigurationVersion
    {
        const scope = request.Scope;
        if (request.Descriptor.Name !== scope.Component) throw new ConfigurationRequestError(scope, ConfigurationAuthoring.OtherComponent);
        if (request.Author.trim() === '') throw new ConfigurationRequestError(scope, ConfigurationAuthoring.NoAuthor);
        if (!Number.isSafeInteger(request.BasedOn) || request.BasedOn < 0) throw new ConfigurationRequestError(scope, ConfigurationAuthoring.BadBase);
        if (request.BasedOn !== head) throw new ConfigurationHeadMovedError(scope, request.BasedOn, head);
        const validation = new ConfigurationValidator(request.Descriptor).Validate(request.Document);
        if (!validation.Valid) throw new ConfigurationRejectedError(scope, validation.Errors);
        return new ConfigurationVersion(
            scope,
            head + 1,
            request.Document as Record<string, JsonValue>,
            request.Descriptor.Version,
            request.Descriptor.ContentDigest(),
            request.Author,
            createdAt,
            request.Comment,
        );
    }

    public static CheckApply(request: ApplyRequest): void
    {
        if (!Number.isSafeInteger(request.Version) || request.Version < 1) throw new ConfigurationRequestError(request.Scope, ConfigurationAuthoring.BadVersion);
        if (request.RequestedBy.trim() === '') throw new ConfigurationRequestError(request.Scope, ConfigurationAuthoring.NoRequester);
    }

    /** The pending record completed with `outcome`, or ApplyOutcomeError. */
    public static Complete(record: ApplyRecord, outcome: ApplyOutcome, at: Date, detail: string): ApplyRecord
    {
        if (outcome === ApplyOutcome.Pending) throw new ApplyOutcomeError(record.Scope, record.Id, ConfigurationAuthoring.PendingOutcome);
        if (record.Outcome !== ApplyOutcome.Pending) throw new ApplyOutcomeError(record.Scope, record.Id, ConfigurationAuthoring.AlreadyCompleted);
        return record.Completed(outcome, at, detail);
    }
}
