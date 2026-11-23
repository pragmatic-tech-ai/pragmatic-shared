import { readFileSync } from 'node:fs';
import { ConfigurationEnvironmentOverlay } from './configuration-environment-overlay.js';

/**
 * How a component reads a secret setting whose declared source is a plain variable (`PRAGMATIC_AGENT_TOKEN`): the file
 * its `_FILE` variable names wins (where the start step writes a configured secret, so the value is never in the process
 * environment), else the plain variable (a deployment that injects it), else none. An empty value or file reads as none;
 * one trailing line break of a file is dropped (a hand-written file ends with one). A file that cannot be read throws
 * naming the variable, never the content.
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
        const file = fileVariable === variable ? undefined : env[fileVariable];
        if (file !== undefined && file !== '')
        {
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
        const value = env[variable];
        return value === undefined || value === '' ? undefined : value;
    }
}
