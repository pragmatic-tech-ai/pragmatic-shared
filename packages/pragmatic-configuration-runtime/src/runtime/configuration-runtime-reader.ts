import { readFile } from 'node:fs/promises';
import { ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfigurationCodec } from '../applied/applied-configuration-codec.js';
import { AppliedConfigurationEntries } from '../applied/applied-configuration-entries.js';
import { AppliedConfigurationError } from '../applied/applied-configuration-error.js';
import { AppliedConfigurationKeys } from '../applied/applied-configuration-keys.js';
import type { AppliedConfiguration } from '../applied/applied-configuration.js';
import { ConfigurationStartError, ConfigurationStartReason } from './configuration-start-error.js';
import { RuntimeConfiguration } from './runtime-configuration.js';
import type { SecretStoreDirectory } from './secret-store-directory.js';
import type { SecretValue } from './secret-value.js';

/**
 * What a component calls at start: reads its applied configuration from the mounted file (the `pragmatic-config-
 * <component>` ConfigMap mounted as a volume, so no Kubernetes API access), refuses a configuration of another
 * component or one validated against another descriptor than this container's own, validates it, and resolves its
 * secret references through the realm's secrets home. It logs nothing; its errors never carry a secret value.
 *
 * The folder holds one entry per descriptor digest (AppliedConfigurationEntries): `configuration.json` when it was
 * validated for this container's descriptor, else the entry prepared beside it for that descriptor
 * (`configuration.json.sha256-<hex>`, same component and realm), else the start is refused (descriptor-mismatch, C
 * Ledger 9). A missing `configuration.json` means no configuration, whatever else the folder holds. `revalidate` (the
 * tenant admin console alone, which owns the configurations and prepares the entries) instead runs an applied document
 * of another descriptor when it validates against its own; `RuntimeConfiguration.Revalidated` then says so.
 */
export class ConfigurationRuntimeReader
{
    public static readonly DefaultDirectory = '/etc/pragmatic/configuration';
    public static readonly DefaultPath = `${ConfigurationRuntimeReader.DefaultDirectory}/${AppliedConfigurationKeys.FileName}`;
    public static readonly PathVariable = 'PRAGMATIC_CONFIGURATION_FILE';

    private static readonly NotFound = 'ENOENT';
    private static readonly Encoding = 'utf8';
    private static readonly ErrorSeparator = '; ';
    private static readonly NonePrepared = '; no configuration prepared for it was found beside it';
    private static readonly EntryOtherDescriptor = 'the prepared entry names another descriptor than its file';
    private static readonly EntryOtherScope = 'the prepared entry is of another component or realm than configuration.json';

    public constructor(
        public readonly Descriptor: ComponentDescriptor,
        private readonly secrets: SecretStoreDirectory,
        private readonly revalidate: boolean = false,
    )
    {
    }

    /** The file to read: PRAGMATIC_CONFIGURATION_FILE when set and non-empty, else the default mount path. */
    public static PathFrom(environment: Readonly<Record<string, string | undefined>>): string
    {
        const path = environment[ConfigurationRuntimeReader.PathVariable];
        return path === undefined || path === '' ? ConfigurationRuntimeReader.DefaultPath : path;
    }

    public async Read(path: string = ConfigurationRuntimeReader.DefaultPath): Promise<RuntimeConfiguration>
    {
        const primary = ConfigurationRuntimeReader.Decode(await ConfigurationRuntimeReader.ReadText(path), path);
        const selected = await this.Select(primary, path);
        const applied = selected.Applied;
        const validation = new ConfigurationValidator(this.Descriptor).Validate(applied.Document);
        if (validation.Configuration === undefined)
        {
            const errors = validation.Errors.map(error => error.toString()).join(ConfigurationRuntimeReader.ErrorSeparator);
            throw new ConfigurationStartError(ConfigurationStartReason.Invalid, `version ${applied.Version} of ${applied.Component} does not validate: ${errors}`);
        }
        const secrets = new Map<string, SecretValue>();
        for (const secret of validation.Configuration.SecretReferences())
        {
            const where = `${secret.Option}.${secret.Setting}`;
            secrets.set(RuntimeConfiguration.SecretKey(secret.Option, secret.Setting), await this.secrets.Resolve(secret.Reference, where));
        }
        return new RuntimeConfiguration(applied.Version, applied.ComponentVersion, applied.DescriptorDigest, validation.Configuration, secrets, applied.Realm, selected.Revalidated);
    }

    // The entry for this container's descriptor: the applied file, else the prepared entry beside it, else (revalidating)
    // the applied file to validate against this descriptor, else a refusal.
    private async Select(primary: AppliedConfiguration, path: string): Promise<{ Applied: AppliedConfiguration; Revalidated: boolean }>
    {
        const R = ConfigurationRuntimeReader;
        const own = this.Descriptor;
        if (primary.Component !== own.Name)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.ComponentMismatch, `the mounted configuration is for ${primary.Component}, this container is ${own.Name}`);
        }
        const digest = own.ContentDigest();
        if (primary.DescriptorDigest === digest) return { Applied: primary, Revalidated: false };
        const entryPath = AppliedConfigurationEntries.PathOf(path, digest);
        const text = await R.ReadOptional(entryPath);
        if (text !== undefined)
        {
            const entry = R.Decode(text, entryPath);
            if (entry.DescriptorDigest !== digest) throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${entryPath}: ${R.EntryOtherDescriptor}`);
            if (entry.Component !== primary.Component || entry.Realm !== primary.Realm) throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${entryPath}: ${R.EntryOtherScope}`);
            return { Applied: entry, Revalidated: false };
        }
        if (this.revalidate) return { Applied: primary, Revalidated: true };
        throw new ConfigurationStartError(
            ConfigurationStartReason.DescriptorMismatch,
            `configuration version ${primary.Version} of ${primary.Component} was validated against descriptor ${primary.DescriptorDigest} (component version ${primary.ComponentVersion}), `
            + `but this container's descriptor is ${digest} (component version ${own.Version})${R.NonePrepared}; save and apply a configuration version validated for ${own.Version}`,
        );
    }

    // A prepared entry's text, or undefined when there is none.
    private static async ReadOptional(path: string): Promise<string | undefined>
    {
        try
        {
            return await ConfigurationRuntimeReader.ReadText(path);
        }
        catch (error)
        {
            if (error instanceof ConfigurationStartError && error.Reason === ConfigurationStartReason.Missing) return undefined;
            throw error;
        }
    }

    private static async ReadText(path: string): Promise<string>
    {
        try
        {
            return await readFile(path, ConfigurationRuntimeReader.Encoding);
        }
        catch (error)
        {
            const code = (error as { code?: unknown }).code;
            if (code === ConfigurationRuntimeReader.NotFound)
            {
                throw new ConfigurationStartError(ConfigurationStartReason.Missing, `no applied configuration at ${path} (is the pragmatic-config ConfigMap mounted?)`);
            }
            throw new ConfigurationStartError(ConfigurationStartReason.Unreadable, `cannot read ${path}: ${String(code)}`);
        }
    }

    private static Decode(text: string, path: string): AppliedConfiguration
    {
        try
        {
            return AppliedConfigurationCodec.Decode(text);
        }
        catch (error)
        {
            if (!(error instanceof AppliedConfigurationError)) throw error;
            throw new ConfigurationStartError(ConfigurationStartReason.Malformed, `${path}: ${error.message}`);
        }
    }
}
