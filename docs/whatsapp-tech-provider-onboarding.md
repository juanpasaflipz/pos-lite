# Conectar WhatsApp por coexistencia — guía de onboarding (Meta directo)

Meta a partir de 2026-07-24. Objetivo: que **+52 56 1309 6835** siga viviendo en la
app WhatsApp Business del teléfono del negocio (pedidos para llevar, leads de DK)
y **además** hable con el servidor de Desktop Kitchen por Cloud API (voice-ops de
inventario hoy, bot de pedidos después).

Elegimos **ir directo con Meta** en lugar de pagar un BSP (Dualhook pausó altas;
360dialog cuesta €49/mes ≈ $1,000 MXN, lo que movería el punto de equilibrio de
DK de 3 a 4 restaurantes). Costo directo: **$0 de plataforma**, solo las tarifas
por mensaje de Meta — y las respuestas dentro de la ventana de 24 h de atención
al cliente son gratis, que es el 100% de lo que hace el bot hoy.

El precio de ir directo es el trámite: para conectar un número que ya está en la
app WhatsApp Business (eso es "coexistencia") hay que ser **Meta Tech Provider**.
Sin ese estatus el pareo por QR falla con *"Error while pairing Cloud API"*.

Ventaja estratégica: siendo Tech Provider, el mismo flujo sirve luego para
conectar los números de los restaurantes clientes — algo que un plan de BSP de un
solo número no permite.

---

## Lo que hace Juan (trámite en Meta)

### 1. App de Meta
En <https://developers.facebook.com/apps> → **Create app** → tipo **Business** →
selecciona el portafolio de negocios de DK. El nombre **no puede contener
"WhatsApp"** (Meta rechaza marcas suyas). Agrega el producto **WhatsApp**.

Anota el **App ID** y el **App Secret** (Settings → Basic).

### 2. Verificación del negocio
Business Manager → **Security Center → Business Verification**. Suben documentos
(acta constitutiva o constancia de situación fiscal, comprobante de domicilio,
teléfono y sitio web que coincidan). También hay que verificar el dominio
`desktop.kitchen`. **Tarda 2–5 días hábiles** y es requisito para el App Review.

> Que los datos del negocio (nombre legal, dirección, teléfono, web) coincidan
> exactamente entre el portafolio, los documentos y el sitio — es la causa #1 de
> rechazo.

### 3. App Review — acceso avanzado
Solicita **advanced access** a estos dos permisos:

- `whatsapp_business_messaging`
- `whatsapp_business_management`

Meta pide evidencia en video. Lo más rápido: graba la pantalla mostrando
(a) el envío de un mensaje con el cURL de *API Setup* del panel de WhatsApp, y
(b) la creación de una plantilla en WhatsApp Manager. Explica en texto que la
plataforma administra cuentas de WhatsApp de restaurantes clientes y envía
mensajes en su nombre.

### 4. Configuración de Embedded Signup
En la app: **Facebook Login for Business → Create configuration**.

- Login variation: **WhatsApp Embedded Signup**
- Assets: **WhatsApp Cloud API** (y *Marketing Messages API* si aparece)
- Permisos de la cuenta de WhatsApp: `MANAGE`, `DEVELOP`, `MANAGE_TEMPLATES` y mensajería
- **Token expiration: Never**

Guarda el **configuration ID** (`config_id`).

### 5. Variables en Railway (antes de conectar)

```
WA_META_APP_ID=<App ID>
WA_META_APP_SECRET=<App Secret>
WA_ES_CONFIG_ID=<configuration ID>
```

Redespliega para que tomen efecto.

---

## Una sola vez: variables de plataforma

Estas son **nuestras**, no del restaurante, y no cambian al conectar números:

```
WA_CLOUD_APP_SECRET=...     (el mismo App Secret de la app de Meta)
WA_CLOUD_VERIFY_TOKEN=...   (invéntalo: cadena aleatoria larga)
```

En la app de Meta → **WhatsApp → Configuration → Webhooks**, registra **una
sola vez**:

- Callback URL: `https://<dominio-railway>/api/wa-cloud/webhook`
- Verify token: el mismo `WA_CLOUD_VERIFY_TOKEN`
- Suscribe los campos **`messages`** y **`smb_message_echoes`**
  (el segundo es lo que avisa al servidor cuando un humano contesta desde el
  teléfono — así el bot nunca habla encima de una conversación humana).

Todos los números que conectemos después — el nuestro y el de cada restaurante
cliente — entran por ese mismo webhook. El servidor sabe de quién es cada
mensaje por el `phone_number_id` que lo recibió.

---

## Conectar un número (10 minutos, con el teléfono a la mano)

Se repite igual para el número de DK y para el de cada restaurante cliente.

1. Confirma que la app WhatsApp Business del teléfono esté **actualizada**
   (mínimo 2.24.17) y que la **foto de perfil ya esté puesta** — después del
   onboarding ya no se puede cambiar desde la API.
2. Abre en una computadora:
   `https://<dominio-railway>/admin/wa-onboarding?secret=<ADMIN_SECRET>`
   Sale la lista de restaurantes con su estado de conexión.
3. Clic en **Generar liga** en el restaurante que toca. La liga **no lleva el
   ADMIN_SECRET** y **vence en 1 hora**: se le puede mandar al dueño para que
   él la corra con su propio teléfono, o la abres tú.
4. En esa liga: **Iniciar Embedded Signup** → inicia sesión con la cuenta de
   Facebook administradora del número → elige el número → **escanea el QR** con
   la app WhatsApp Business del teléfono.
5. Decide si sincronizas hasta **6 meses de historial** — es una decisión
   **permanente**, se toma una sola vez.
6. Listo. La página confirma el número conectado y el servidor **guarda solo
   las credenciales de ese restaurante** (`tenant_credentials`,
   `service='whatsapp'`). No hay que copiar nada a Railway ni redesplegar: el
   número queda activo de inmediato.

> El token nunca se muestra en pantalla ni se escribe en los logs — quien abre
> la liga puede ser el cliente, no nosotros. Si algún día hay que meterlo a
> mano, los campos están en **Integraciones → WhatsApp** del propio tenant.

---

## Prueba de humo (obligatoria antes de confiar)

| Prueba | Qué mandar | Resultado esperado |
|---|---|---|
| Empleado, nota de voz | "tiré tres burritos" desde el teléfono de un empleado registrado | Llega el borrador con SI/NO; al responder SI se registra la merma |
| Empleado, foto de recibo | Foto de un ticket de compra | Borrador de compra con proveedor y total |
| **Cliente** | Mensaje desde un número que **no** es empleado | **Silencio absoluto** del sistema; el mensaje queda sin leer en el teléfono para que lo conteste un humano |
| Humano contesta | Responder a ese cliente desde la app | El servidor lo registra como *echo* y no hace nada |

Si la tercera falla y un cliente recibe respuesta automática:

- **Un solo número** (el de DK): vacía `WA_CLOUD_ACCESS_TOKEN` en Railway y
  redespliega. Ojo: esto **no** apaga los números de restaurantes clientes —
  esos guardan su token en `tenant_credentials`, no en el env. Para uno de
  ellos, borra la integración de WhatsApp en su pantalla de Integraciones.
- **Todos los números a la vez** (paro de emergencia): vacía
  `WA_CLOUD_APP_SECRET` y redespliega. Sin app secret ninguna firma se puede
  verificar, así que la ruta contesta 503 a todo y todo sigue funcionando en
  los teléfonos.

---

## Reglas que no hay que olvidar

- **Abrir la app WhatsApp Business del teléfono al menos cada 14 días**, o la
  sincronización de coexistencia se rompe.
- **Grupos y llamadas** siguen siendo solo de la app (las **notas de voz** sí
  pasan por la API — el inventario no se ve afectado).
- Un número en coexistencia **no puede** obtener la palomita azul (Official
  Business Account). Meta Verified es la alternativa.
- Los **dispositivos vinculados se desconectan** al conectar; solo WhatsApp para
  Windows se puede volver a vincular. Si alguien toma pedidos desde WhatsApp Web
  en el navegador, eso deja de funcionar.
- Coexistencia está disponible en México (excluidos: UE/Reino Unido, India,
  Australia, Japón, Corea del Sur, Nigeria, Filipinas, Sudáfrica, Turquía, Rusia
  — según el proveedor, la lista se ha ido abriendo).
- **Política de IA de Meta (15 enero 2026):** lo prohibido son los asistentes de
  IA de propósito general distribuidos por WhatsApp (ChatGPT, Perplexity). Usar
  IA para atender a los clientes del propio negocio — pedidos, FAQ, inventario —
  sigue permitido. El bot de DK cae del lado permitido.

## Plan B

Si el App Review se atora, **360dialog** (€49/mes) hace onboarding de
coexistencia self-serve y su API es casi idéntica a la de Meta
(`waba-v2.360dialog.io`, header `D360-API-KEY`): el adaptador necesitaría un
cambio de ~10 líneas (URL base y header de auth), nada más.
