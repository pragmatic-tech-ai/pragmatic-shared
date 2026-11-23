import type { ComponentDeclaration } from '@pragmatic-tech-ai/pragmatic-component';
import { RuntimeConfiguration } from './runtime-configuration.js';

/** Which secret settings a reader resolves (the others stay references). */
export interface ISecretSelection
{
    Resolves(option: string, setting: string): boolean;
}

/**
 * The secrets the start step needs: those of settings the component declares a `source` for (the variable the overlay
 * writes the resolved secret's file to). Settings without a source are read by the component itself from its applied
 * document, so their secret references may name a store only the component has (the realm sign-in service's realm
 * store, opened after its database); resolving them at start would refuse a configuration the component can read.
 */
export class DeclaredSourceSecrets implements ISecretSelection
{
    private readonly sourced = new Set<string>();

    public constructor(declaration: ComponentDeclaration)
    {
        for (const option of declaration.options)
        {
            for (const setting of option.settings)
            {
                if (setting.source !== undefined) this.sourced.add(RuntimeConfiguration.SecretKey(option.name, setting.name));
            }
        }
    }

    public Resolves(option: string, setting: string): boolean
    {
        return this.sourced.has(RuntimeConfiguration.SecretKey(option, setting));
    }
}
