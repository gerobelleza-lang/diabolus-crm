import type { SignatureProvider, SignaturePayload, SignatureResult, ProviderInfo } from './types'

/**
 * MockSignatureProvider — para desarrollo y tests.
 * Genera un hash SHA-256 real usando Web Crypto API (compatible con Edge Runtime).
 * En producción: sustituir por FirmaaFyAdapter cambiando solo .env
 */
export class MockSignatureProvider implements SignatureProvider {
  async sign(payload: SignaturePayload): Promise<SignatureResult> {
    const data = JSON.stringify(payload)
    const hash = await sha256(data)

    // Simular un XML de factura simplificado
    const xmlInvoice = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">`,
      `  <ID>${payload.invoiceId}</ID>`,
      `  <IssueDate>${payload.timestamp.toISOString().split('T')[0]}</IssueDate>`,
      `  <LegalMonetaryTotal>`,
      `    <PayableAmount currencyID="${payload.currency}">${payload.amount}</PayableAmount>`,
      `  </LegalMonetaryTotal>`,
      `  <BuyerCustomerParty>`,
      `    <Party><PartyName><Name>${payload.clientName}</Name></PartyName></Party>`,
      `  </BuyerCustomerParty>`,
      `  <SHA256>${hash}</SHA256>`,
      `</Invoice>`,
    ].join('\n')

    return {
      signedDocument: btoa(xmlInvoice),
      hash,
      signature: `MOCK_SIG_${hash.substring(0, 16).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      providerReference: `MOCK-${Date.now()}`,
    }
  }

  async validate(_signedDocument: string): Promise<boolean> {
    // Mock: siempre válido
    return true
  }

  getInfo(): ProviderInfo {
    return {
      name: 'Mock Provider',
      version: '1.0.0',
      costPerSignature: 0,
      supportsVeriFactu: false,
    }
  }
}

// ─── Utilidades ────────────────────────────────────────────────────────────

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder()
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(message))
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
