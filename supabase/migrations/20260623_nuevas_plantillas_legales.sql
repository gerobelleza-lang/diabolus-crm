-- ============================================================
-- Nuevas plantillas legales — Diabolus CRM
-- Migración: 20260623_nuevas_plantillas_legales
-- ============================================================

INSERT INTO legal_templates (slug, name, description, category, variables, body)
VALUES

-- ────────────────────────────────────────────────────────────────────
-- 1. CONTRATO DE ARRENDAMIENTO DE SILLA / CABINA
-- ────────────────────────────────────────────────────────────────────
(
  'arrendamiento-silla',
  'Arrendamiento de silla / cabina',
  'Contrato de arrendamiento de puesto de trabajo (silla o cabina) entre el titular del salón y un profesional autónomo. Régimen de alquiler fijo mensual.',
  'contratos',
  '["prov_nombre","prov_nif","prov_domicilio","cli_nombre","cli_nif","cli_domicilio","descripcion_puesto","fecha_inicio","duracion_meses","renta_mensual","dia_pago","fianza","localidad","fecha_contrato"]',
  'CONTRATO DE ARRENDAMIENTO DE PUESTO DE TRABAJO (SILLA / CABINA)

En {{localidad}}, a {{fecha_contrato}}.

REUNIDOS

De una parte, D./Dña. {{prov_nombre}}, con NIF {{prov_nif}}, domiciliado/a en {{prov_domicilio}}, en calidad de ARRENDADOR/A y titular del establecimiento.

De otra parte, D./Dña. {{cli_nombre}}, con NIF {{cli_nif}}, domiciliado/a en {{cli_domicilio}}, en calidad de ARRENDATARIO/A, actuando como profesional autónomo/a dado/a de alta en el Régimen Especial de Trabajadores Autónomos (RETA).

EXPONEN

I. Que el/la ARRENDADOR/A es titular del espacio profesional descrito a continuación y desea ceder su uso.

II. Que el/la ARRENDATARIO/A es profesional autónomo/a del sector de la estética y/o peluquería, interesado/a en arrendar dicho puesto para el desarrollo de su actividad por cuenta propia.

Ambas partes se reconocen capacidad legal suficiente y, en consecuencia, acuerdan suscribir el presente contrato de arrendamiento conforme a las siguientes:

CLÁUSULAS

PRIMERA — OBJETO
El/la ARRENDADOR/A cede en arrendamiento al ARRENDATARIO/A el uso exclusivo de {{descripcion_puesto}}, sito en el establecimiento ubicado en {{prov_domicilio}}, junto con el acceso a las zonas comunes (sala de espera, zonas de lavado, almacén compartido y servicios) en los términos establecidos en este contrato.

El/la ARRENDATARIO/A ejercerá su actividad profesional de manera totalmente independiente, con plena autonomía en la organización de su trabajo, sin que exista relación laboral ni societaria con el/la ARRENDADOR/A.

SEGUNDA — DURACIÓN
El presente contrato tendrá una duración de {{duracion_meses}} meses, con inicio el día {{fecha_inicio}}.

Transcurrido el plazo inicial, el contrato se prorrogará tácitamente por periodos mensuales salvo que cualquiera de las partes notifique a la otra, con un mínimo de 30 días de antelación, su voluntad de no prorrogarlo.

TERCERA — RENTA Y FORMA DE PAGO
La renta mensual acordada es de {{renta_mensual}} euros (IVA no incluido), a satisfacer por el/la ARRENDATARIO/A no más tarde del día {{dia_pago}} de cada mes, mediante transferencia bancaria a la cuenta que el/la ARRENDADOR/A designe.

El importe de la renta podrá ser revisado anualmente conforme a la variación del IPC publicado por el INE.

CUARTA — FIANZA
A la firma del presente contrato, el/la ARRENDATARIO/A entrega en concepto de fianza la cantidad de {{fianza}} euros, equivalente a una mensualidad de renta. Dicha cantidad será devuelta en el plazo máximo de 15 días desde la finalización del contrato, previa comprobación del estado del puesto arrendado.

QUINTA — OBLIGACIONES DEL ARRENDATARIO/A
El/la ARRENDATARIO/A se obliga a:
a) Mantener el puesto en perfecto estado de limpieza y orden.
b) Respetar las normas de convivencia del establecimiento.
c) Disponer de la titulación profesional exigida por la normativa vigente.
d) Contar con seguro de responsabilidad civil profesional en vigor.
e) Facturar a sus propios clientes con su propio NIF, sin utilizar en ningún caso la razón social del/la ARRENDADOR/A.
f) Abonar los gastos de los materiales consumibles que utilice en su actividad, salvo pacto expreso en contrario.

SEXTA — OBLIGACIONES DEL ARRENDADOR/A
El/la ARRENDADOR/A se obliga a:
a) Mantener el espacio arrendado en condiciones adecuadas de uso.
b) Garantizar el suministro de agua, electricidad y los servicios básicos incluidos en la renta.
c) No interferir en la actividad profesional del/la ARRENDATARIO/A.

SÉPTIMA — RESOLUCIÓN ANTICIPADA
Cualquiera de las partes podrá resolver el contrato anticipadamente notificándolo por escrito con 30 días de antelación. El incumplimiento grave de las obligaciones de cualquiera de las partes faculta a la otra para la resolución inmediata del contrato, con derecho a reclamar los daños y perjuicios causados.

OCTAVA — INDEPENDENCIA PROFESIONAL Y LABORAL
Queda expresamente excluida cualquier relación laboral entre las partes. El/la ARRENDATARIO/A actúa en todo momento como empresario/a autónomo/a y asume en exclusiva sus obligaciones fiscales, de Seguridad Social y de facturación frente a sus clientes.

NOVENA — PROTECCIÓN DE DATOS
Cada parte trata los datos de la otra exclusivamente para la gestión de este contrato, de conformidad con el Reglamento (UE) 2016/679 (RGPD) y la Ley Orgánica 3/2018 (LOPDGDD).

DÉCIMA — JURISDICCIÓN
Para cualquier controversia derivada del presente contrato, ambas partes se someten a los Juzgados y Tribunales del domicilio del establecimiento, renunciando a cualquier otro fuero que pudiera corresponderles.

Y en prueba de conformidad, firman el presente contrato por duplicado en el lugar y fecha indicados.

ARRENDADOR/A                              ARRENDATARIO/A
{{prov_nombre}}                           {{cli_nombre}}
NIF: {{prov_nif}}                         NIF: {{cli_nif}}

Firma: _______________________            Firma: _______________________

[BORRADOR — Revise con su asesor legal antes de su uso]'
),

-- ────────────────────────────────────────────────────────────────────
-- 2. ACUERDO DE CONFIDENCIALIDAD (NDA) — EMPLEADO / COLABORADOR
-- ────────────────────────────────────────────────────────────────────
(
  'acuerdo-confidencialidad',
  'Acuerdo de confidencialidad (NDA)',
  'Acuerdo de no divulgación para empleados, colaboradores o proveedores externos. Cubre datos de clientes, precios, fórmulas y know-how del negocio.',
  'contratos',
  '["prov_nombre","prov_nif","prov_domicilio","cli_nombre","cli_nif","cli_puesto","fecha_inicio","duracion_post_meses","localidad","fecha_contrato"]',
  'ACUERDO DE CONFIDENCIALIDAD Y NO DIVULGACIÓN

En {{localidad}}, a {{fecha_contrato}}.

PARTES

EMPRESA: {{prov_nombre}}, con NIF {{prov_nif}}, domicilio en {{prov_domicilio}} (en adelante, "la Empresa").

COLABORADOR/A: {{cli_nombre}}, con NIF {{cli_nif}}, que presta servicios en el puesto de {{cli_puesto}} (en adelante, "el/la Colaborador/a").

ANTECEDENTES

Con motivo de la relación laboral o de colaboración existente entre las partes, el/la Colaborador/a tendrá acceso a información confidencial propiedad de la Empresa. El presente acuerdo regula las condiciones de uso y protección de dicha información.

CLÁUSULAS

PRIMERA — INFORMACIÓN CONFIDENCIAL
Se considera "Información Confidencial" toda aquella a la que el/la Colaborador/a acceda en el ejercicio de sus funciones, incluyendo, sin carácter limitativo:
a) Datos personales de clientes (nombres, teléfonos, historiales de tratamiento, preferencias).
b) Listas de proveedores, precios, condiciones comerciales y descuentos.
c) Fórmulas, técnicas, tratamientos y procedimientos de trabajo propios de la Empresa.
d) Información financiera, de facturación y contable.
e) Planes de negocio, estrategias de marketing y proyectos futuros.
f) Software, sistemas de gestión y bases de datos de la Empresa.

SEGUNDA — OBLIGACIONES DEL COLABORADOR/A
El/la Colaborador/a se obliga a:
a) Mantener en estricta confidencialidad toda la Información Confidencial.
b) No divulgar, copiar, transmitir ni facilitar el acceso a terceros sin autorización expresa por escrito.
c) Utilizar la Información Confidencial exclusivamente para el desempeño de sus funciones.
d) Notificar inmediatamente a la Empresa cualquier acceso no autorizado del que tenga conocimiento.

TERCERA — EXCEPCIONES
Las obligaciones de confidencialidad no se aplicarán a información que:
a) Sea o pase a ser de dominio público sin incumplimiento del presente acuerdo.
b) Deba ser divulgada por mandato legal o resolución judicial firme.

CUARTA — VIGENCIA
El presente acuerdo es efectivo desde {{fecha_inicio}} y permanecerá en vigor durante toda la relación de colaboración y durante los {{duracion_post_meses}} meses posteriores a su finalización, cualquiera que sea la causa.

QUINTA — CONSECUENCIAS DEL INCUMPLIMIENTO
El incumplimiento de las obligaciones establecidas en este acuerdo podrá dar lugar a:
a) La resolución inmediata de la relación laboral o de colaboración.
b) La reclamación de daños y perjuicios conforme a los artículos 1101 y siguientes del Código Civil.
c) Las acciones penales que procedan, en particular las previstas en el artículo 197 y concordantes del Código Penal en materia de revelación de secretos.

SEXTA — PROTECCIÓN DE DATOS
El/la Colaborador/a reconoce que el tratamiento de datos de clientes debe realizarse conforme al RGPD (UE) 2016/679 y la LOPDGDD 3/2018, quedando vinculado/a a las instrucciones de tratamiento de la Empresa como encargado/a de tratamiento en los términos del artículo 28 del RGPD.

SÉPTIMA — JURISDICCIÓN
Para cualquier controversia, las partes se someten a los Juzgados y Tribunales del domicilio de la Empresa.

En prueba de conformidad,

LA EMPRESA                                EL/LA COLABORADOR/A
{{prov_nombre}}                           {{cli_nombre}}
NIF: {{prov_nif}}                         NIF: {{cli_nif}}

Firma: _______________________            Firma: _______________________

[BORRADOR — Revise con su asesor legal antes de su uso]'
),

-- ────────────────────────────────────────────────────────────────────
-- 3. POLÍTICA DE CANCELACIÓN Y NO-SHOW
-- ────────────────────────────────────────────────────────────────────
(
  'politica-cancelacion',
  'Política de cancelación y no-show',
  'Documento que el cliente firma al reservar o en primera visita, aceptando la política de cancelaciones y penalización por no presentarse (no-show).',
  'contratos',
  '["prov_nombre","prov_nif","prov_domicilio","cli_nombre","cli_nif","horas_cancelacion","porcentaje_penalizacion","importe_max_penalizacion","localidad","fecha_contrato"]',
  'ACEPTACIÓN DE POLÍTICA DE CANCELACIÓN Y NO-SHOW

En {{localidad}}, a {{fecha_contrato}}.

DATOS DEL ESTABLECIMIENTO
Nombre: {{prov_nombre}}
NIF: {{prov_nif}}
Domicilio: {{prov_domicilio}}

DATOS DEL CLIENTE
Nombre: {{cli_nombre}}
NIF/DNI: {{cli_nif}}

POLÍTICA DE CANCELACIÓN

El/la abajo firmante declara haber leído y acepta expresamente las siguientes condiciones:

1. RESERVAS
   La reserva de cualquier servicio queda sujeta a las condiciones establecidas en el presente documento.

2. CANCELACIÓN SIN COSTE
   El/la cliente podrá cancelar o modificar su cita sin coste alguno siempre que lo comunique con un mínimo de {{horas_cancelacion}} horas de antelación a la hora prevista del servicio, a través de cualquiera de los canales de comunicación disponibles (teléfono, WhatsApp o mensaje en el sistema de reservas).

3. CANCELACIÓN TARDÍA
   La cancelación realizada con menos de {{horas_cancelacion}} horas de antelación, así como la no presentación sin previo aviso (no-show), generará una penalización equivalente al {{porcentaje_penalizacion}}% del precio del servicio reservado, con un máximo de {{importe_max_penalizacion}} euros.

4. REITERACIÓN
   La reiteración de no-shows (3 o más en un período de 12 meses) facultará al establecimiento a exigir el prepago total del servicio como condición para aceptar futuras reservas, o a denegar el servicio conforme a sus políticas internas.

5. CASOS EXCEPCIONALES
   El establecimiento valorará individualmente circunstancias de fuerza mayor debidamente justificadas (urgencias médicas, etc.), pudiendo eximir de la penalización a su discreción.

6. BASE LEGAL
   Esta política se fundamenta en el artículo 1124 del Código Civil (resolución de obligaciones recíprocas) y en los artículos 147 y siguientes del Real Decreto Legislativo 1/2007 (TRLGDCU) en lo que respecta a los derechos del consumidor.

CONSENTIMIENTO EXPRESO

El/la cliente declara:
- Haber sido informado/a de la presente política antes de confirmar su primera reserva.
- Entender y aceptar las condiciones establecidas.
- Que la penalización no modifica ni sustituye el precio del servicio finalmente realizado.

{{prov_nombre}}                           EL/LA CLIENTE
NIF: {{prov_nif}}                         {{cli_nombre}} — NIF: {{cli_nif}}

Firma: _______________________            Firma: _______________________

[BORRADOR — Revise con su asesor legal antes de su uso]'
),

-- ────────────────────────────────────────────────────────────────────
-- 4. AUTORIZACIÓN TRATAMIENTO DE SERVICIOS — MENOR DE EDAD
-- ────────────────────────────────────────────────────────────────────
(
  'autorizacion-menor',
  'Autorización servicios a menor de edad',
  'Autorización que firman los padres o tutores legales para que un menor pueda recibir servicios de peluquería, estética o tratamientos capilares.',
  'rgpd',
  '["prov_nombre","prov_nif","prov_domicilio","menor_nombre","menor_dni","menor_fecha_nacimiento","tutor_nombre","tutor_nif","tutor_parentesco","servicio_autorizado","observaciones","localidad","fecha_contrato"]',
  'AUTORIZACIÓN PARENTAL PARA PRESTACIÓN DE SERVICIOS A MENOR DE EDAD

En {{localidad}}, a {{fecha_contrato}}.

DATOS DEL ESTABLECIMIENTO
{{prov_nombre}} — NIF: {{prov_nif}}
{{prov_domicilio}}

DATOS DEL/LA MENOR
Nombre completo: {{menor_nombre}}
DNI/Pasaporte: {{menor_dni}}
Fecha de nacimiento: {{menor_fecha_nacimiento}}

DATOS DEL REPRESENTANTE LEGAL
Nombre: {{tutor_nombre}}
NIF: {{tutor_nif}}
Relación con el/la menor: {{tutor_parentesco}}

DECLARACIÓN Y AUTORIZACIÓN

D./Dña. {{tutor_nombre}}, en calidad de representante legal del/la menor {{menor_nombre}}, DECLARA:

1. Ser titular de la patria potestad o tutela legal del/la menor indicado/a, o estar autorizado/a expresamente por quien la ostenta.

2. AUTORIZA expresamente a {{prov_nombre}} a realizar los siguientes servicios sobre el/la menor:
   {{servicio_autorizado}}

3. DECLARA que el/la menor no presenta, que sea de su conocimiento, ninguna alergia, condición médica o medicación que pueda interferir con los servicios autorizados. En caso contrario, indica:
   Observaciones: {{observaciones}}

4. CONSIENTE el tratamiento de los datos personales del/la menor (nombre, imagen en ficha de cliente) por parte de {{prov_nombre}} conforme al RGPD (UE) 2016/679 y la LOPDGDD 3/2018, con la única finalidad de prestar los servicios autorizados y mantener el historial de tratamientos.

5. BASE LEGAL: La prestación de servicios a menores requiere consentimiento del representante legal conforme al artículo 7 de la Ley Orgánica 1/1982 y el artículo 8 del RGPD. El tratamiento de datos de menores de 14 años requiere consentimiento parental conforme al artículo 7 de la LOPDGDD 3/2018.

REPRESENTANTE LEGAL
{{tutor_nombre}}
NIF: {{tutor_nif}}

Firma: _______________________

[BORRADOR — Revise con su asesor legal antes de su uso]'
),

-- ────────────────────────────────────────────────────────────────────
-- 5. CONSENTIMIENTO INFORMADO — TRATAMIENTOS ESTÉTICOS
-- ────────────────────────────────────────────────────────────────────
(
  'consentimiento-estetico',
  'Consentimiento informado — tratamientos estéticos',
  'Consentimiento informado que el cliente firma antes de recibir tratamientos con posibles efectos secundarios: keratina, tinte, extensiones, láser, dermapen, etc.',
  'contratos',
  '["prov_nombre","prov_nif","prov_domicilio","cli_nombre","cli_nif","tratamiento","descripcion_tratamiento","riesgos","contraindicaciones","profesional_nombre","localidad","fecha_contrato"]',
  'CONSENTIMIENTO INFORMADO PARA TRATAMIENTO ESTÉTICO O CAPILAR

En {{localidad}}, a {{fecha_contrato}}.

ESTABLECIMIENTO: {{prov_nombre}} — NIF: {{prov_nif}} — {{prov_domicilio}}

CLIENTE: {{cli_nombre}} — NIF/DNI: {{cli_nif}}

PROFESIONAL RESPONSABLE: {{profesional_nombre}}

────────────────────────────────────────────────────────────────────────

INFORMACIÓN SOBRE EL TRATAMIENTO

Tratamiento: {{tratamiento}}

Descripción: {{descripcion_tratamiento}}

Posibles efectos secundarios y riesgos:
{{riesgos}}

Contraindicaciones conocidas (no aplicar si el cliente presenta):
{{contraindicaciones}}

────────────────────────────────────────────────────────────────────────

DECLARACIONES DEL CLIENTE

El/la abajo firmante, D./Dña. {{cli_nombre}}, DECLARA:

1. INFORMACIÓN RECIBIDA: Que el/la profesional le ha explicado de forma clara y comprensible en qué consiste el tratamiento {{tratamiento}}, sus beneficios, posibles efectos secundarios, riesgos y contraindicaciones.

2. AUSENCIA DE CONTRAINDICACIONES: Que, hasta donde alcanza su conocimiento, no presenta ninguna de las contraindicaciones indicadas anteriormente ni otras que pudieran ser relevantes para el tratamiento. En caso de haberlas, las ha comunicado expresamente al profesional.

3. ALERGIAS E HISTORIAL: Que ha informado al profesional de cualquier alergia conocida (especialmente a tintes, productos capilares, metales, látex o productos cosméticos), tratamientos médicos en curso y condiciones de salud relevantes.

4. TEST DE ALERGIA: Que ha sido informado/a de la conveniencia de realizar una prueba de alergia (patch test) con una antelación mínima de 48 horas cuando así lo recomiende el profesional, y que su decisión de no realizarla, en caso de haberse ofrecido, es voluntaria y con pleno conocimiento de los riesgos.

5. CONSENTIMIENTO LIBRE Y VOLUNTARIO: Que presta su consentimiento de forma libre, informada y sin presión de ningún tipo para la realización del tratamiento descrito.

6. DERECHO DE REVOCACIÓN: Que puede retirar este consentimiento en cualquier momento antes del inicio del tratamiento, sin necesidad de justificación y sin perjuicio alguno, mediante comunicación al profesional.

7. BASE LEGAL: Este consentimiento se fundamenta en el artículo 8 de la Ley 41/2002, de autonomía del paciente (aplicable analógicamente a tratamientos estéticos con posible riesgo), y en el artículo 6.1.a) del RGPD para el tratamiento del historial de servicios.

────────────────────────────────────────────────────────────────────────

FIRMA

EL/LA CLIENTE                             EL/LA PROFESIONAL
{{cli_nombre}}                            {{profesional_nombre}}
NIF: {{cli_nif}}

Firma: _______________________            Firma: _______________________

[BORRADOR — Revise con su asesor legal antes de su uso]'
)

ON CONFLICT (slug) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  variables   = EXCLUDED.variables,
  body        = EXCLUDED.body,
  updated_at  = now();
