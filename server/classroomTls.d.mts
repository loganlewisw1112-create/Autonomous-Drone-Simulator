export interface ClassroomCertificates {
  caCertificatePath: string
  caCertificatePem: string
  leafCertificatePath: string
  leafCertificatePem: string
  leafPrivateKeyPath: string
  leafPrivateKeyPem: string
  fingerprint256: string
  hosts: string[]
}

export declare function ensureClassroomCertificates(options: {
  directory: string
  hosts?: string[]
  now?: Date
}): Promise<ClassroomCertificates>
