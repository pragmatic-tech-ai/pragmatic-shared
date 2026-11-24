/** The member names of the component descriptor's JSON form (schema 1). */
export class DescriptorKeys
{
    public static readonly SchemaVersion = 1;

    public static readonly Schema = 'schema';
    public static readonly Component = 'component';
    public static readonly Version = 'version';
    public static readonly Options = 'options';
    public static readonly Name = 'name';
    public static readonly Description = 'description';
    public static readonly Settings = 'settings';
    public static readonly Type = 'type';
    public static readonly Required = 'required';
    public static readonly Secret = 'secret';
    public static readonly Default = 'default';
    /** Optional, integer settings only; absent from every descriptor that declares none, so its JSON and digest are unchanged. */
    public static readonly Minimum = 'minimum';
    public static readonly Maximum = 'maximum';
    public static readonly Roles = 'roles';
    public static readonly Storage = 'storage';
    public static readonly Postgres = 'postgres';
    public static readonly Endpoints = 'endpoints';
    public static readonly Ports = 'ports';
    public static readonly Port = 'port';
    public static readonly Health = 'health';
    public static readonly Path = 'path';
}
