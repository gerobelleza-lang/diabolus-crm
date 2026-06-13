/**
 * SignatureProvider Abstraction — Diabolus CRM
 *
 * Permite cambiar el proveedor de firma (Mock → FirmaaFy → cualquier otro)
 * sin tocar el código de negocio. Solo cambiar SIGNATURE_PROVIDER en .env
 */

export interface SignaturePayload {
  invoiceId: string
  amount: number
  currency: 'EUR'
  clientName: string
  clientEmail: string
  description: string
  timestamp: Date
  salonId: string
}

export interface SignatureResult {
  signedDocument: string       // Base64 del documento firmado (XML/PDF)
  hash: string                 // SHA-256 del payload original
  signature: string            // Firma digital
  timestamp: string            // ISO 8601
  certificateChain?: string    // Cadena de certificados (opcional)
  providerReference?: string   // Referencia del proveedor externo
}

export interface ProviderInfo {
  name: string
  version: string
  costPerSignature: number     // En euros
  supportsVeriFactu: boolean
}

export interface SignatureProvider {
  sign(payload: SignaturePayload): Promise<SignatureResult>
  validate(signedDocument: string): Promise<boolean>
  getInfo(): ProviderInfo
}
