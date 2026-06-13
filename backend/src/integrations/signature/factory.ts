import type { SignatureProvider } from './types'
import { MockSignatureProvider } from './mock'

/**
 * Factory — devuelve el proveedor configurado en SIGNATURE_PROVIDER.
 * Agregar nuevos proveedores aquí sin tocar el resto del código.
 */
export function getSignatureProvider(): SignatureProvider {
  const provider = (process.env.SIGNATURE_PROVIDER ?? 'mock').toLowerCase()

  switch (provider) {
    case 'mock':
      return new MockSignatureProvider()

    // case 'firmaafy':
    //   return new FirmaaFyAdapter(
    //     process.env.FIRMAAFY_API_KEY!,
    //     process.env.FIRMAAFY_API_SECRET!
    //   )

    default:
      throw new Error(
        `Unknown SIGNATURE_PROVIDER: "${provider}". Valid values: mock, firmaafy`
      )
  }
}
