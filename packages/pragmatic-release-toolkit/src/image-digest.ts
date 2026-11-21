/** Reads an image's content digest (a local docker image id, or the digest a registry reference pins). */
export interface IImageDigest
{
    Of(imageRef: string): Promise<string>
}
