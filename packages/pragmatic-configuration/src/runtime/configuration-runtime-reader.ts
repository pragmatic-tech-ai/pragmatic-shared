import { readFile } from 'node:fs/promises';
import { ConfigurationValidator } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor } from '@pragmatic-tech-ai/pragmatic-component';
import { AppliedConfigurationCodec } from '../applied/applied-configuration-codec.js';
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
 */
export class ConfigurationRuntimeReader
{
    public static readonly DefaultDirectory = '/etc/pragmatic/configuration';
    public static readonly DefaultPath = `${ConfigurationRuntimeReader.DefaultDirectory}/${AppliedConfigurationKeys.FileName}`;
    public static readonly PathVariable = 'PRAGMATIC_CONFIGURATION_FILE';

    private static readonly NotFound = 'ENOENT';
    private static readonly Encoding = 'utf8';
    private static readonly ErrorSeparator = '; ';

    public constructor(
        public readonly Descriptor: ComponentDescriptor,
        private readonly secrets: SecretStoreDirectory,
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
        const applied = ConfigurationRuntimeReader.Decode(await ConfigurationRuntimeReader.ReadText(path), path);
        this.CheckDescriptor(applied);
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
        return new RuntimeConfiguration(applied.Version, applied.ComponentVersion, applied.DescriptorDigest, validation.Configuration, secrets);
    }

    private CheckDescriptor(applied: AppliedConfiguration): void
    {
        const own = this.Descriptor;
        if (applied.Component !== own.Name)
        {
            throw new ConfigurationStartError(ConfigurationStartReason.ComponentMismatch, `the mounted configuration is for ${applied.Component}, this container is ${own.Name}`);
        }
        if (applied.DescriptorDigest !== own.ContentDigest())
        {
            throw new ConfigurationStartError(
                ConfigurationStartReason.DescriptorMismatch,
                `configuration version ${applied.Version} of ${applied.Component} was validated against descriptor ${applied.DescriptorDigest} (component version ${applied.ComponentVersion}), `
                + `but this container's descriptor is ${own.ContentDigest()} (component version ${own.Version}); save and apply a configuration version validated for ${own.Version}`,
            );
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
