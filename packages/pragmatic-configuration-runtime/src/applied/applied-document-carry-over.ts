import { CanonicalJson } from '@pragmatic-tech-ai/pragmatic-component';
import type { ComponentDescriptor, ConfigurationError, JsonValue } from '@pragmatic-tech-ai/pragmatic-component';
import { JsonDocument } from '../repository/json-document.js';

/** A document carried over to another descriptor, and the members (`option` or `option.setting`) left behind. */
export class CarriedDocument
{
    public readonly Dropped: readonly string[];

    public constructor(public readonly Document: unknown, dropped: readonly string[])
    {
        this.Dropped = Object.freeze([...dropped]);
        Object.freeze(this);
    }
}

/**
 * Carries an applied document (validated for one descriptor, its defaults filled in) over to another descriptor of the
 * same component: the options and settings the target descriptor no longer declares are left behind, since the new
 * version cannot read them. With the descriptor the document was validated for (`inherited`), only what that descriptor
 * filled in is left behind (a member equal to its default): a value an admin set for a setting that is gone is kept, so
 * validation refuses it by name (a renamed setting must not silently fall back to its default). Without it, every
 * undeclared member is left behind (the tenant admin console's own start, which must not be stopped by a retired
 * setting). Never changes a declared member.
 */
export class AppliedDocumentCarryOver
{
    private static readonly OptionsKey = 'options';
    private static readonly Separator = '.';
    private static readonly OptionsPointer = '/options/';
    private static readonly PointerSeparator = '/';
    private static readonly EscapedSlash = /~1/g;
    private static readonly EscapedTilde = /~0/g;
    private static readonly Slash = '/';
    private static readonly Tilde = '~';

    /** The members (`option` or `option.setting`) validation errors point at; errors about the document itself point at none. */
    public static MembersOf(errors: readonly ConfigurationError[]): string[]
    {
        const A = AppliedDocumentCarryOver;
        const members = errors
            .filter(e => e.Path.startsWith(A.OptionsPointer))
            .map(e => e.Path.slice(A.OptionsPointer.length).split(A.PointerSeparator).slice(0, 2)
                .map(s => s.replace(A.EscapedSlash, A.Slash).replace(A.EscapedTilde, A.Tilde)).join(A.Separator));
        return [...new Set(members)];
    }

    /** `document` without `members` (`option` or `option.setting`); those present are reported dropped. */
    public static Without(document: unknown, members: readonly string[]): CarriedDocument
    {
        const A = AppliedDocumentCarryOver;
        if (!JsonDocument.IsObject(document) || !JsonDocument.IsObject(document[A.OptionsKey])) return new CarriedDocument(document, []);
        const options = structuredClone(document[A.OptionsKey] as Record<string, JsonValue>);
        const dropped: string[] = [];
        for (const member of members)
        {
            const cut = member.indexOf(A.Separator);
            const option = cut < 0 ? member : member.slice(0, cut);
            const value = options[option];
            if (cut < 0)
            {
                if (option in options)
                {
                    delete options[option];
                    dropped.push(member);
                }
            }
            else if (JsonDocument.IsObject(value) && member.slice(cut + 1) in value)
            {
                delete value[member.slice(cut + 1)];
                dropped.push(member);
            }
        }
        return new CarriedDocument({ ...document, [A.OptionsKey]: options }, dropped);
    }

    public static Carry(document: unknown, target: ComponentDescriptor, inherited?: ComponentDescriptor): CarriedDocument
    {
        const A = AppliedDocumentCarryOver;
        if (!JsonDocument.IsObject(document) || !JsonDocument.IsObject(document[A.OptionsKey])) return new CarriedDocument(document, []);
        const options = document[A.OptionsKey] as Record<string, JsonValue>;
        const kept: Record<string, JsonValue> = {};
        const dropped: string[] = [];
        for (const [name, value] of Object.entries(options))
        {
            const option = target.Option(name);
            if (option === undefined)
            {
                if (A.Inherited(inherited, name, value)) dropped.push(name);
                else kept[name] = value;
                continue;
            }
            if (!JsonDocument.IsObject(value))
            {
                kept[name] = value;
                continue;
            }
            const settings: Record<string, JsonValue> = {};
            for (const [setting, settingValue] of Object.entries(value))
            {
                const declared = option.Settings.some(s => s.Name === setting);
                if (!declared && A.InheritedSetting(inherited, name, setting, settingValue)) dropped.push(name + A.Separator + setting);
                else settings[setting] = settingValue;
            }
            kept[name] = settings;
        }
        return new CarriedDocument({ ...document, [A.OptionsKey]: kept }, dropped);
    }

    // A whole option the target lacks: left behind when every setting in it is the inherited default (or no inherited descriptor).
    private static Inherited(inherited: ComponentDescriptor | undefined, option: string, value: JsonValue): boolean
    {
        if (inherited === undefined) return true;
        if (!JsonDocument.IsObject(value)) return false;
        return Object.entries(value).every(([setting, settingValue]) => AppliedDocumentCarryOver.InheritedSetting(inherited, option, setting, settingValue));
    }

    private static InheritedSetting(inherited: ComponentDescriptor | undefined, option: string, setting: string, value: JsonValue): boolean
    {
        if (inherited === undefined) return true;
        const declared = inherited.Option(option)?.Settings.find(s => s.Name === setting);
        return declared?.Default !== undefined && CanonicalJson.Stringify(declared.Default) === CanonicalJson.Stringify(value);
    }
}
