import { DecodeReason, ProtocolDecodeError } from './protocol-decode-error.js'

/** Reading a message's text: a byte limit first, then JSON. The text never appears in an error. */
export class ProtocolJson
{
    private static readonly Root = 'message'
    private static readonly Utf8 = 'utf8'

    public static Parse(text: string, maxBytes: number): unknown
    {
        if (Buffer.byteLength(text, ProtocolJson.Utf8) > maxBytes)
        {
            throw new ProtocolDecodeError(ProtocolJson.Root, DecodeReason.TooLarge)
        }
        try
        {
            return JSON.parse(text) as unknown
        }
        catch
        {
            throw new ProtocolDecodeError(ProtocolJson.Root, DecodeReason.NotJson)
        }
    }
}
