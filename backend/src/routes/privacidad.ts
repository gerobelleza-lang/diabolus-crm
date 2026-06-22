// @ts-nocheck
import type { Hono } from 'hono';

export function registerPrivacidadRoute(app: Hono) {
  app.get('/api/privacidad', (c) => {
    return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — Diabolus CRM</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; line-height: 1.7; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #e00; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    footer { margin-top: 60px; font-size: 0.85em; color: #999; border-top: 1px solid #eee; padding-top: 20px; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Diabolus CRM</strong> — Última actualización: junio 2026</p>

  <h2>1. Responsable del tratamiento</h2>
  <p>Gerobelleza, con domicilio en España. Contacto: <a href="mailto:support@diabolus.es">support@diabolus.es</a></p>

  <h2>2. Datos que recopilamos</h2>
  <p>Recopilamos únicamente los datos necesarios para prestar el servicio: nombre, teléfono, correo electrónico e historial de conversaciones a través de WhatsApp Business API.</p>

  <h2>3. Finalidad del tratamiento</h2>
  <p>Los datos se utilizan exclusivamente para gestionar la relación comercial entre los salones de belleza (clientes B2B) y sus clientes finales, incluyendo recordatorios de citas y comunicaciones de cobro.</p>

  <h2>4. Base legal</h2>
  <p>Interés legítimo y consentimiento explícito del usuario al iniciar la conversación vía WhatsApp, conforme al RGPD (Reglamento UE 2016/679) y la LOPDGDD.</p>

  <h2>5. Conservación de datos</h2>
  <p>Los datos se conservan durante la vigencia de la relación contractual y 5 años adicionales por obligaciones legales, salvo solicitud de supresión por parte del interesado.</p>

  <h2>6. Derechos del interesado</h2>
  <p>Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad y oposición enviando un correo a <a href="mailto:support@diabolus.es">support@diabolus.es</a>.</p>

  <h2>7. Transferencias internacionales</h2>
  <p>Los datos pueden ser procesados por subencargados (OpenAI, Supabase, Meta) con las garantías adecuadas conforme al RGPD.</p>

  <h2>8. Uso de WhatsApp Business API</h2>
  <p>Esta aplicación utiliza la API de WhatsApp Business de Meta para comunicaciones comerciales. Los mensajes se tratan conforme a las políticas de uso de Meta y el RGPD.</p>

  <footer>
    <p>Diabolus CRM · <a href="mailto:support@diabolus.es">support@diabolus.es</a> · España</p>
  </footer>
</body>
</html>`);
  });
}
