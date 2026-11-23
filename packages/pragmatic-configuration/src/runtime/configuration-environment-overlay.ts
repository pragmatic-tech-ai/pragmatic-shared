import { chmod, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalJson } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDeclaration, SettingDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import type { RuntimeConfiguration } from './runtime-configuration.js';
import { SettingValueEncoding } from './setting-value-encoding.js';

/**
 * Lays a component's applied configuration over its process environment, by the variables its declaration already
 * names (each setting's `source`), so the component's own settings readers stay as they are.
 *
 * - A configured setting of an enabled option overrides its variable, encoded per type (`SettingValueEncoding`).
 * - The applied document carries the descriptor defaults filled in, so it cannot tell a default the admin left alone
 *   from one typed in: a value equal to the descriptor default does not override a variable that is already set.
 *   Unconfigured settings (and options not enabled) keep the environment's value, or the component's own default.
 * - A secret never reaches the environment: its value is written to `<secrets>/<option>.<setting>` (mode 0400) and its
 *   file variable (`<source>_FILE`, or `source` itself when it already names a file) points at it; the plain variable is
 *   removed, so the configured secret wins over one the deployment injects.
 * - Every run first empties the secrets directory (a per-pod memory-backed volume that survives an in-place restart),
 *   so a restart rewrites the files instead of finding stale ones.
 * - Settings without a `source` are read by the component from its applied configuration document; they are skipped.
 *
 * It logs nothing (C Ledger 10).
 */
export class ConfigurationEnvironmentOverlay
{
    public static readonly FileSuffix = '_FILE';
    public static readonly SecretFileMode = 0o400;
    private static readonly DirectoryMode = 0o700;
    private static readonly WritableMode = 0o600;
    private static readonly NameSeparator = '.';

    public constructor(
        private readonly declaration: ComponentDeclaration,
        public readonly SecretsDirectory: string,
    )
    {
    }

    /** The variable that names a secret setting's file. */
    public static FileVariable(source: string): string
    {
        const O = ConfigurationEnvironmentOverlay;
        return source.endsWith(O.FileSuffix) ? source : source + O.FileSuffix;
    }

    /** `<option>.<setting>`: how a setting is named in a start report and in its secret file's name. */
    public static SettingName(option: string, setting: string): string
    {
        return option + ConfigurationEnvironmentOverlay.NameSeparator + setting;
    }

    /** The file a secret setting is written to. */
    public SecretFile(option: string, setting: string): string
    {
        return join(this.SecretsDirectory, ConfigurationEnvironmentOverlay.SettingName(option, setting));
    }

    /** Overlays `configuration` onto `env` in place; answers the settings it set (`<option>.<setting>`, names only). */
    public async Apply(configuration: RuntimeConfiguration, env: NodeJS.ProcessEnv): Promise<readonly string[]>
    {
        await this.ClearSecrets();
        const applied: string[] = [];
        for (const option of this.declaration.options)
        {
            if (!configuration.IsEnabled(option.name)) continue;
            for (const setting of option.settings)
            {
                if (setting.source === undefined) continue;
                if (await this.ApplySetting(configuration, option.name, setting, setting.source, env))
                {
                    applied.push(ConfigurationEnvironmentOverlay.SettingName(option.name, setting.name));
                }
            }
        }
        return Object.freeze(applied);
    }

    private async ApplySetting(configuration: RuntimeConfiguration, option: string, setting: SettingDeclaration, source: string, env: NodeJS.ProcessEnv): Promise<boolean>
    {
        const O = ConfigurationEnvironmentOverlay;
        if (setting.secret === true)
        {
            const secret = configuration.Secret(option, setting.name);
            if (secret === undefined) return false;
            const file = this.SecretFile(option, setting.name);
            await writeFile(file, secret.Reveal(), { mode: O.SecretFileMode });
            await chmod(file, O.SecretFileMode);
            const variable = O.FileVariable(source);
            env[variable] = file;
            if (variable !== source) delete env[source];
            return true;
        }
        const value = configuration.Value(option, setting.name);
        if (value === undefined) return false;
        if (env[source] !== undefined && O.IsDefault(setting, value)) return false;
        env[source] = SettingValueEncoding.Encode(setting.type, value);
        return true;
    }

    private static IsDefault(setting: SettingDeclaration, value: unknown): boolean
    {
        return setting.default !== undefined && CanonicalJson.Stringify(setting.default) === CanonicalJson.Stringify(value);
    }

    private async ClearSecrets(): Promise<void>
    {
        const O = ConfigurationEnvironmentOverlay;
        await mkdir(this.SecretsDirectory, { recursive: true, mode: O.DirectoryMode });
        for (const entry of await readdir(this.SecretsDirectory, { withFileTypes: true }))
        {
            if (!entry.isFile()) continue;
            const file = join(this.SecretsDirectory, entry.name);
            await chmod(file, O.WritableMode);
            await unlink(file);
        }
    }
}
