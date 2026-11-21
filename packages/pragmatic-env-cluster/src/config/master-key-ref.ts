/** How the AES master key is referenced: a key file, or base64 in an environment variable. */
export type MasterKeyRef = { keyFilePath: string } | { base64Env: string }
