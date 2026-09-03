# Buscador de Inmuebles

App para buscar propiedades combinando **6 portales inmobiliarios reales de
Santa Cruz, Bolivia**, pensada para que la use más de un agente (cada uno con
su propia cuenta, datos completamente aislados del resto). Es más que un
buscador: cada agente arma su CRM liviano encima — requerimientos de
clientes, historial de qué ya les mandó, y una base de agentes/inmobiliarias
que se construye sola con cada búsqueda.

Todo el backend vive en **un solo archivo, `server.js`** (Node puro, sin
dependencias obligatorias, sin framework). El frontend es HTML+JS plano, sin
build step — se edita y se recarga, nada que compilar.

## Arquitectura en 2 minutos

- **`server.js`**: un `http.createServer` con un router manual
  (`manejarRequest`, un enorme `if (url.pathname === ...)` en cascada). No
  hay Express ni nada — cada ruta se agrega ahí mismo.
- **Multi-tenant por archivo**: cada agente tiene sus propios
  `data/requerimientos-<id>.json`, `data/inventario-<id>.json`,
  `data/captadores-<id>.json`, etc. — aislamiento total, sin base de datos,
  todo JSON plano en disco. `data/agentes.json` es el índice de cuentas
  (email, apiKey, hash de contraseña).
- **Autenticación**: header `X-Api-Key` por agente (`autenticar(req)`);
  panel de administración aparte con `X-Admin-Key` (`esAdmin(req)`,
  variable `ADMIN_KEY`).
- **6 fuentes de datos**, cada una con su propio `fetchXxx()` +
  `normalizarXxx()`, combinadas en `buscarTodo(req)` — ver detalle abajo.
- **`public/`**: `index.html` (buscador principal), `inventario.html` (Mi
  Inventario + perfil + vitrina), `agentes.html` (base de
  agentes/inmobiliarias), `vitrina.html` (página pública del inventario de
  un agente), `admin.html` (panel de José Luis).

## Las 6 fuentes de datos

| Fuente | Mecanismo | Notas |
|---|---|---|
| **Century 21** (c21.com.bo) | API JSON pública (`?json=true`), paginada | La más completa: teléfono/WhatsApp/email del captador |
| **RE/MAX** (remax.bo) | API JSON pública (`/api/search/{venta\|alquiler}`), paginada | La operación (venta/alquiler) va en la URL, no en un query param — bug real corregido el 2026-08-07 |
| **BienInmuebles** (bieninmuebles.com.bo) | Endpoint AJAX propio (`procesos.php`, POST), paginado secuencial | Sin fecha de publicación en el catálogo |
| **Mobiliario App** (mobiliario.app) | Sync en 2do plano + caché — sitemap.xml + schema.org JSON-LD por propiedad | ~8.000 propiedades, la más grande. No hay búsqueda masiva, por eso el sync |
| **CapitalCorp** (capitalcorp.com.bo) | Sync en 2do plano + caché — endpoint de mapa (bulk) + regex sobre el HTML de cada ficha | Sin teléfono: el sitio ofusca el número a propósito (dígitos reales intercalados con decoys ocultos por CSS) — se respeta, no se intenta esquivar |
| **Alfa Bolivia** (alfa.bo) | Sync en 2do plano + caché — HTML de listado (Next.js RSC) con balanceo manual de llaves | Sin teléfono (sí email del agente), sin lat/lon. Extracción más frágil que las demás (depende del build interno de Next.js) |

**Patrón repetido 3 veces** (Mobiliario/CapitalCorp/Alfa Bolivia): estos 3
portales no tienen una API de búsqueda masiva, así que en vez de pegarle a
la fuente en cada búsqueda de un agente, hay un **sync en segundo plano**
(`sincronizarXxx()`) que llena `data/cache-xxx.json`, y las búsquedas leen
de ahí (`fetchXxx()` — rápido, sin red). El sync se dispara solo al
arrancar el server y se re-chequea cada hora (`chequearResyncXxx`,
`setInterval`). **Importante**: el flag `enProgreso` de cada caché es solo
informativo — nunca se usa para decidir si arrancar un sync nuevo (si el
proceso muere a mitad de camino, ese flag queda pegado en `true` para
siempre en el archivo; la protección real contra sync duplicados es un
flag en MEMORIA que se resetea solo en cada arranque del proceso).

Century 21 / RE/MAX / BienInmuebles sí responden en vivo, sin caché — se
paginan automáticamente hasta traer el catálogo completo de cada categoría
(con un techo de seguridad por las dudas).

## Qué hace (funcionalidad real, no solo búsqueda)

- **Búsqueda combinada de las 6 fuentes**, con zona, precio, m² (terreno y
  construcción por separado), dormitorios, baños, antigüedad, palabras
  clave ("debe mencionar" / "excluir"), tolerancia de presupuesto (12%,
  marca "cerca del presupuesto" en vez de descartar).
- **Fusión de duplicados entre fuentes** (`fusionarDuplicados`): cuando la
  misma propiedad aparece publicada en 2+ portales (mismo precio EXACTO +
  coordenadas casi idénticas, o mismo precio + mismo m²), se muestra como
  UNA tarjeta con "También en: X, Y" en vez de repetirla. Deliberadamente
  conservador (prefiere no fusionar antes que esconder una propiedad real
  por error). Verificado en vivo: ~38% de "casa en venta" eran duplicados
  cruzados antes de este filtro.
- **Estado real de cada fuente**: chip verde/rojo por portal en cada
  búsqueda, con el motivo real si alguna falló — nunca se confunde "0
  resultados" con "no pude preguntar".
- **ACM (Análisis Comparativo de Mercado)**: no es una IA adivinando un
  precio — pondera cada comparable por fuente, tamaño (similitud al
  "sujeto"), recencia y nivel (A=cierre real cargado a mano, B=scrapeado,
  C=referencia informal), descarta outliers, calcula mediana de precio y
  de precio/m². Redacción con IA opcional encima del número ya calculado.
- **Reporte de zona** (`POST /api/reporte-zona`): a diferencia de una
  búsqueda filtrada por el presupuesto de un cliente puntual, este botón
  genera un link público con **todo** lo que hay en una zona/tipo/
  operación — pensado para presentarle opciones a un cliente. La página
  pública (`/reporte/:agenteId/:id`) nunca expone el contacto del agente
  original de cada aviso, solo la marca y el WhatsApp del dueño de la
  cuenta.
- **Base de agentes/inmobiliarias que se arma sola** (`agentes.html`, datos
  en `data/captadores-<id>.json`): cada búsqueda registra automáticamente
  quién vende qué (nombre, oficina, teléfono/WhatsApp si la fuente lo
  expone), deduplicado. Vista buscable/ordenable por cantidad de
  propiedades o más reciente.
- **Historial de "enviados" por requerimiento**: marcar una propiedad como
  ya mandada a ese cliente, para no repetirla.
- **Flujo de aprobación humana antes de mandarle algo al cliente**
  (integración GHL): el bot de WhatsApp de la subcuenta detecta un
  requerimiento → la app busca matches → arma una propuesta en estado
  `pendiente` → el agente la revisa/edita en una página propia
  (`/revisar/:agenteId/:id`) → recién ahí se genera el link de
  presentación real para el cliente (`/p/:agenteId/:id`). Nunca manda algo
  directo sin que un humano lo vea primero.
- **Barrido activo cada 12h**: re-busca en las 6 fuentes para cada
  requerimiento guardado (no solo reacciona a lo nuevo que aparece).
- **Mi Inventario** (`inventario.html`): inventario propio del agente +
  captaciones de otros agentes cargadas a mano, con sincronización desde
  una carpeta de Google Drive (fotos + IA leyendo fichas en PDF).
- **Vitrina pública** (`vitrina.html`): página del inventario de un agente
  para compartir con colegas.
- Voz (Web Speech API) e IA (Gemini gratis o Claude de pago, opcional) para
  interpretar pedidos en lenguaje natural y resumir resultados.
- Mapa (Leaflet + OpenStreetMap, gratis) con las propiedades que traen
  coordenadas.

## Cómo se usa

```
node server.js
```

Abrir `http://localhost:3456`. Sin ninguna cuenta creada, corre en **modo
abierto** (un solo espacio de datos). Apenas se registra el primer agente
(`POST /api/registrar`, o desde la pantalla de acceso), pasa sola a modo
multiagente — todo `/api/*` exige `X-Api-Key`.

```
node scripts/agentes.js crear "Nombre del agente"
node scripts/agentes.js listar
node scripts/agentes.js revocar <id>
```

## Variables de entorno (`.env`, ver `.env.example`)

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | IA gratis (Google Gemini) — recomendada para arrancar |
| `ANTHROPIC_API_KEY` | IA de pago (Claude) — alternativa si no hay Gemini |
| `ADMIN_KEY` | Clave del panel `/admin.html` |
| `APP_BASE_URL` | Opcional — fuerza la URL base de los links públicos del reporte de zona. Sin esto, se arma sola del `Host` de cada request (funciona igual en localhost, LAN o el dominio público real) |
| `GOOGLE_API_KEY` | Para leer archivos de Google Drive (Mi Inventario) |
| `WEBHOOK_SECRET` | Protege el webhook `/webhooks/ghl-mensaje` (extracción en tiempo real del bot de GHL) |
| `META_APP_ID` / `META_APP_SECRET` | Integración opcional de Meta Ads (gasto/leads por agente) — no configurada hoy |

## Deploy (Railway)

Código listo para desplegar sin cambios (`process.env.PORT`, `Procfile`).
Deploy manual: `railway up --ci` desde esta carpeta (requiere `railway
login` + `railway link` una vez).

**⚠️ Estado actual (2026-08-27): el trial de Railway venció.** La URL
pública (`https://buscador-inmuebles-production.up.railway.app`) está
offline hasta que se elija un plan pago (Hobby, ~US$5/mes). Los datos
NO se perdieron — quedan intactos en el volumen persistente
(`buscador-inmuebles-volume`, montado en `/app/data`) para cuando se
reactive. Mientras tanto, José Luis usa la app corriendo local en su
propia compu.

**Importante si se recrea el proyecto en Railway desde cero**: hay que
volver a crear el volumen persistente (`railway volume add --mount-path
/app/data`) ANTES de que agentes reales se registren — sin volumen, cada
redeploy borra todo.

## Seguridad de las claves

- `data/agentes.json`, todo `data/*.json` y `.env` están en `.gitignore` —
  **nunca se suben al repo**. Si necesitás las API keys reales o algún dato
  de un agente para probar algo, pedíselas a José Luis directamente, no
  están en este código fuente.
- Las contraseñas de cuentas (registro/login) se guardan hasheadas (scrypt
  nativo de Node). Las `apiKey` en sí son tokens en texto plano dentro de
  `data/agentes.json`, como cualquier API key — de ahí que ese archivo esté
  excluido del repo.
- Una clave revocada deja de funcionar al toque.

## Puntos a tener en cuenta si vas a tocar el código

- **Ningún fetch a un portal debería quedar sin timeout.** Bug real
  encontrado el 2026-08-25: sin `AbortSignal.timeout(...)`, una sola
  conexión trabada colgaba toda la búsqueda para siempre. Las 4 funciones
  base de fetch (`fetchJson`, `fetchJsonPost`, `fetchTexto`, y el fetch de
  CapitalCorp) ya lo tienen — si agregás un fetch nuevo a un portal, sumale
  timeout también.
- **Filtro de cordura de precio** (`umbralTypo`): varias fuentes a veces
  publican un precio absurdamente bajo (typo, o el propio HTML del portal
  trunca el número). El patrón ya establecido: si `precio < 1000` (venta) o
  `< 10` (alquiler), se descarta el precio (`null`, no se inventa nada) en
  vez de mostrar un número que claramente está mal.
- **"No inventes, no completes"**: si un dato no viene de la fuente, se
  deja `null`/vacío — nunca se adivina ni se rellena con el dato de otro
  aviso parecido. Aplica en todos los normalizadores.
- **Antes de sumar una fuente nueva**, revisar SIEMPRE su `robots.txt`
  primero. Si bloquea explícitamente (a cualquier bot, o puntualmente a
  Claude) o pide un rate-limit muy restrictivo (ej. 60s entre pedidos), no
  se integra — queda como link directo nomás. Ver el caso real de
  "Inversionistas de Impacto" (idi-jireh.com) investigado el 2026-08-25.
