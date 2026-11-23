import type { ApplyOutcome, ApplyRecord, ApplyRequest, ApplyTarget } from './apply-record.js';
import type { ConfigurationSaveRequest } from './configuration-save-request.js';
import type { ConfigurationScope } from '@pragmatic-tech-ai/pragmatic-configuration-runtime';
import type { ConfigurationVersion } from './configuration-version.js';

/**
 * The tenant admin console's configuration repository: per scope (realm + component) an ordered sequence of validated
 * configuration versions, and the record of which version was applied to which deployment, when, by whom, with what
 * outcome. Versions are append-only; apply records are append-only except for their one outcome.
 */
export interface IConfigurationRepository
{
    /** Validates the document against the request's descriptor and appends it as version head + 1. Throws
     *  ConfigurationRequestError (malformed request), ConfigurationHeadMovedError (BasedOn is not the head: optimistic
     *  concurrency) or ConfigurationRejectedError (invalid document, literal secrets). */
    Save(request: ConfigurationSaveRequest): Promise<ConfigurationVersion>;

    /** The newest version, or null before the first save. */
    Head(scope: ConfigurationScope): Promise<ConfigurationVersion | null>;

    Version(scope: ConfigurationScope, version: number): Promise<ConfigurationVersion | null>;

    /** Every version of the scope, oldest first. */
    Versions(scope: ConfigurationScope): Promise<readonly ConfigurationVersion[]>;

    /** The components of a realm that have at least one version, by name. */
    Components(realm: string): Promise<readonly string[]>;

    /** Records a pending apply of a saved version (ConfigurationVersionNotFoundError for an unknown one). */
    BeginApply(request: ApplyRequest): Promise<ApplyRecord>;

    /** Records the outcome (applied or failed) of a pending apply, once (ApplyRecordNotFoundError, ApplyOutcomeError). */
    CompleteApply(scope: ConfigurationScope, id: number, outcome: ApplyOutcome, detail: string): Promise<ApplyRecord>;

    /** Every apply of the scope, oldest first. */
    Applies(scope: ConfigurationScope): Promise<readonly ApplyRecord[]>;

    /** The newest successful apply to the target (the version running there), or null. */
    Applied(scope: ConfigurationScope, target: ApplyTarget): Promise<ApplyRecord | null>;
}
