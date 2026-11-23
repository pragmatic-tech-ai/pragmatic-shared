import { readFileSync } from 'node:fs';
import { ConfigurationEnvironmentOverlay } from './configuration-environment-overlay.js';

/**
 * How a component reads a secret setting whose declared source is a plain variable (`PRAGMATIC_AGENT_TOKEN`): the file
 * its `_FILE` variable names wins (where the start step writes a configured secret, so the value is never in the process
 * environment), else the plain variable (a deployment that injects it), else none. When the declared source itself
 * names a file (`..._FILE`), the file it names is read. An empty value or file reads as none; one trailing line break of
 * a file is dropped (a hand-written file ends with one; `MountedSecretStore` reads by the same rule). A file that cannot
 * be read throws naming the variable, never the content.
 */
export class SecretVariable
{
    private static readonly Encoding = 'utf8';
    private static readonly TrailingLineBreak = /\r?\n$/;
    private static readonly Unreadable = 'cannot read the secret file named by';

    public static Read(env: NodeJS.ProcessEnv, variable: string): string | undefined
    {
        const S = SecretVariable;
        const fileVariable = ConfigurationEnvironmentOverlay.FileVariable(variable);
        const file = env[fileVariable];
        if (fileVariable === variable || (file !== undefined && file !== ''))
        {
            return file === undefined || file === '' ? undefined : S.ReadFile(file, fileVariable);
        }
        const value = env[variable];
        return value === undefined || value === '' ? undefined : value;
    }

    private static ReadFile(file: string, fileVariable: string): string | undefined
    {
        const S = SecretVariable;
        let text: string;
        try
        {
            text = readFileSync(file, S.Encoding);
        }
        catch (error)
        {
            throw new Error(`${S.Unreadable} ${fileVariable}: ${String((error as { code?: unknown }).code)}`);
        }
        const value = text.replace(S.TrailingLineBreak, '');
        return value === '' ? undefined : value;
    }
}
