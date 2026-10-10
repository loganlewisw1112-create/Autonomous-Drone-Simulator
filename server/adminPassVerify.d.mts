export interface AdminPassClaim {
  email: string
  name: string
  passId: string
  issuedAt: number
  expiresAt?: number
}

export interface AdminPassVerifyOptions {
  trustedPublicKeys: readonly string[]
  revokedPassIds?: readonly string[]
  now?: number
}

export declare const ADMIN_PASS_PREFIX: 'DSA1'
export declare const ADMIN_PASS_DOMAIN: string
export declare function base64UrlToBytes(value: string): Uint8Array | null
export declare function bytesToBase64Url(bytes: Uint8Array): string
export declare function adminPassSigningBytes(payloadB64: string): Uint8Array
export declare function verifyAdminPassText(pass: unknown, options: AdminPassVerifyOptions): AdminPassClaim | null
