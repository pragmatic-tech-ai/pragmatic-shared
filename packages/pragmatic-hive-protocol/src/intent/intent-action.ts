import { SigningPublicKey } from '../crypto/signing-key.js'
import { DecodeReason } from '../wire/protocol-decode-error.js'
import { ProtocolNames } from '../wire/protocol-names.js'
import { StrictFields } from '../wire/strict-fields.js'

/** What an intent asks the hive to bring about. */
export enum IntentActionKind
{
    ComponentAtVersion = 'component-at-version',
    CreateEnvironment = 'create-environment',
    UpdateEnvironment = 'update-environment',
    DeleteEnvironment = 'delete-environment',
    Rotate = 'rotate',
    Repair = 'repair',
}

/** What a rotate intent renews. */
export enum RotationSubject
{
    /** The hive's identity key: the agent generates a new pair and enrols its public half under the same hive id. */
    HiveKey = 'hive-key',
    /** The console's ingress certificate. */
    IngressCertificate = 'ingress-certificate',
    /** The platform's trust root: the new key is in the intent, signed by the current one. */
    TrustRoot = 'trust-root',
}

/** What a repair intent compares and restores (desired against observed state). */
export enum RepairScope
{
    Engine = 'engine',
    Component = 'component',
    Environment = 'environment',
}

/** What a created environment is for: development (a blank workspace) or runtime (an application with its database). */
export enum EnvironmentPurpose
{
    Development = 'development',
    Runtime = 'runtime',
}

/** The configuration version a component runs with (pragmatic-configuration: realm and version of its scope). */
export class ConfigurationReference
{
    private static readonly Field = { Realm: 'Realm', Version: 'Version' } as const
    private static readonly Members: readonly string[] = Object.values(ConfigurationReference.Field)

    public constructor(public readonly Realm: string, public readonly Version: number)
    {
    }

    public static Parse(value: unknown, path: string): ConfigurationReference
    {
        const F = ConfigurationReference.Field
        const fields = StrictFields.Exactly(value, ConfigurationReference.Members, path)
        return new ConfigurationReference(fields.String(F.Realm, { Max: 63, Pattern: ProtocolNames.Label }), fields.Integer(F.Version, { Min: 1 }))
    }

    public ToJson(): { Realm: string, Version: number }
    {
        return { Realm: this.Realm, Version: this.Version }
    }
}

/** The members every action shares. */
export class IntentActionFields
{
    public static readonly Kind = 'Kind'
    public static readonly Environment = 'Environment'
    public static readonly Version = 'Version'

    public static ReadEnvironment(fields: StrictFields): string
    {
        return fields.String(IntentActionFields.Environment, { Max: 63, Pattern: ProtocolNames.Label })
    }
}

/** One intent action: its kind and its own closed members. */
export interface IIntentAction
{
    readonly Kind: IntentActionKind
    ToJson(): Record<string, unknown>
}

/** "Component X at version V": the release image by digest, its component descriptor's digest, its configuration. */
export class ComponentAtVersion implements IIntentAction
{
    public readonly Kind = IntentActionKind.ComponentAtVersion
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, 'Component', 'Version', 'ImageDigest', 'DescriptorDigest', 'Configuration']

    public constructor(
        public readonly Component: string,
        public readonly Version: string,
        public readonly ImageDigest: string,
        public readonly DescriptorDigest: string,
        public readonly Configuration: ConfigurationReference | null)
    {
    }

    public static Read(fields: StrictFields): ComponentAtVersion
    {
        const [, component, version, image, descriptor, configuration] = ComponentAtVersion.Members as [string, string, string, string, string, string]
        return new ComponentAtVersion(
            fields.String(component, { Pattern: ProtocolNames.Component }),
            fields.String(version, { Pattern: ProtocolNames.Version }),
            fields.String(image, { Pattern: ProtocolNames.Digest }),
            fields.String(descriptor, { Pattern: ProtocolNames.Digest }),
            fields.NullableRead(configuration, (raw, at) => ConfigurationReference.Parse(raw, at)))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Component: this.Component, Version: this.Version, ImageDigest: this.ImageDigest, DescriptorDigest: this.DescriptorDigest, Configuration: this.Configuration?.ToJson() ?? null }
    }
}

/** "Create environment E" for a purpose, at the engine's version (null) or a stated one the hive must run. */
export class CreateEnvironment implements IIntentAction
{
    public readonly Kind = IntentActionKind.CreateEnvironment
    public static readonly PurposeField = 'Purpose'
    public static readonly Purposes: readonly EnvironmentPurpose[] = Object.values(EnvironmentPurpose)
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, IntentActionFields.Environment, CreateEnvironment.PurposeField, IntentActionFields.Version]

    public constructor(public readonly Environment: string, public readonly Purpose: EnvironmentPurpose, public readonly Version: string | null)
    {
    }

    public static Read(fields: StrictFields): CreateEnvironment
    {
        return new CreateEnvironment(
            IntentActionFields.ReadEnvironment(fields),
            fields.Enum(CreateEnvironment.PurposeField, CreateEnvironment.Purposes),
            fields.NullableString(IntentActionFields.Version, { Pattern: ProtocolNames.Version }))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Environment: this.Environment, Purpose: this.Purpose, Version: this.Version }
    }
}

/** "Environment E at version V". */
export class UpdateEnvironment implements IIntentAction
{
    public readonly Kind = IntentActionKind.UpdateEnvironment
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, IntentActionFields.Environment, IntentActionFields.Version]

    public constructor(public readonly Environment: string, public readonly Version: string)
    {
    }

    public static Read(fields: StrictFields): UpdateEnvironment
    {
        return new UpdateEnvironment(IntentActionFields.ReadEnvironment(fields), fields.String(IntentActionFields.Version, { Pattern: ProtocolNames.Version }))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Environment: this.Environment, Version: this.Version }
    }
}

/** "Delete environment E". */
export class DeleteEnvironment implements IIntentAction
{
    public readonly Kind = IntentActionKind.DeleteEnvironment
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, IntentActionFields.Environment]

    public constructor(public readonly Environment: string)
    {
    }

    public static Read(fields: StrictFields): DeleteEnvironment
    {
        return new DeleteEnvironment(IntentActionFields.ReadEnvironment(fields))
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Environment: this.Environment }
    }
}

/** "Rotate S"; a trust-root rotation carries the new platform key (and only it does). */
export class Rotate implements IIntentAction
{
    public readonly Kind = IntentActionKind.Rotate
    public static readonly Subjects: readonly RotationSubject[] = Object.values(RotationSubject)
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, 'Subject', 'NewTrustRoot']

    public constructor(public readonly Subject: RotationSubject, public readonly NewTrustRoot: SigningPublicKey | null)
    {
    }

    public static Read(fields: StrictFields): Rotate
    {
        const [, subjectField, rootField] = Rotate.Members as [string, string, string]
        const subject = fields.Enum(subjectField, Rotate.Subjects)
        const root = fields.NullableRead(rootField, (raw, at) => SigningPublicKey.Parse(raw, at))
        if ((root !== null) !== (subject === RotationSubject.TrustRoot))
        {
            throw fields.Refuse(rootField, DecodeReason.Inconsistent)
        }
        return new Rotate(subject, root)
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Subject: this.Subject, NewTrustRoot: this.NewTrustRoot?.ToJson() ?? null }
    }
}

/** "Repair": compare desired with observed state and restore it, for the engine, one component or one environment. */
export class Repair implements IIntentAction
{
    public readonly Kind = IntentActionKind.Repair
    public static readonly Scopes: readonly RepairScope[] = Object.values(RepairScope)
    public static readonly Members: readonly string[] = [IntentActionFields.Kind, 'Scope', 'Name']

    public constructor(public readonly Scope: RepairScope, public readonly Name: string | null)
    {
    }

    public static Read(fields: StrictFields): Repair
    {
        const [, scopeField, nameField] = Repair.Members as [string, string, string]
        const scope = fields.Enum(scopeField, Repair.Scopes)
        const pattern = scope === RepairScope.Component ? ProtocolNames.Component : ProtocolNames.Label
        const name = fields.NullableString(nameField, { Max: 63, Pattern: pattern })
        if ((name === null) !== (scope === RepairScope.Engine))
        {
            throw fields.Refuse(nameField, DecodeReason.Inconsistent)
        }
        return new Repair(scope, name)
    }

    public ToJson(): Record<string, unknown>
    {
        return { Kind: this.Kind, Scope: this.Scope, Name: this.Name }
    }
}

export type IntentAction = ComponentAtVersion | CreateEnvironment | UpdateEnvironment | DeleteEnvironment | Rotate | Repair

/** The action union's strict decoder: the `Kind` member picks the closed shape. */
export class IntentActions
{
    public static readonly Kinds: readonly IntentActionKind[] = Object.values(IntentActionKind)

    public static Parse(value: unknown, path: string): IntentAction
    {
        const kind = StrictFields.Of(value, path).Enum(IntentActionFields.Kind, IntentActions.Kinds)
        switch (kind)
        {
            case IntentActionKind.ComponentAtVersion:
                return ComponentAtVersion.Read(StrictFields.Exactly(value, ComponentAtVersion.Members, path))
            case IntentActionKind.CreateEnvironment:
                return CreateEnvironment.Read(StrictFields.Exactly(value, CreateEnvironment.Members, path))
            case IntentActionKind.UpdateEnvironment:
                return UpdateEnvironment.Read(StrictFields.Exactly(value, UpdateEnvironment.Members, path))
            case IntentActionKind.DeleteEnvironment:
                return DeleteEnvironment.Read(StrictFields.Exactly(value, DeleteEnvironment.Members, path))
            case IntentActionKind.Rotate:
                return Rotate.Read(StrictFields.Exactly(value, Rotate.Members, path))
            case IntentActionKind.Repair:
                return Repair.Read(StrictFields.Exactly(value, Repair.Members, path))
        }
    }
}
