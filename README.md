# Buscador de Inmuebles

App para buscar propiedades según los requerimientos de clientes, pensada para
que la use más de un agente inmobiliario (cada uno con su propia clave de
acceso y sus propios requerimientos guardados, sin ver los del resto).

## Qué hace

- **Análisis Comparativo de Mercado (ACM)**: botón "Generar ACM" en los
  resultados — calcula estadísticas reales sobre los comparables encontrados
  (mediana y promedio de precio, rango, mediana de precio por m²) y, si la IA
  está activa, redacta un análisis breve con rango de valor sugerido,
  comparables destacados y una recomendación práctica. La mediana se usa como
  referencia principal (no el promedio) porque un par de avisos con precio
  atípico no debería mover tanto la referencia — igual que hace un tasador de
  verdad. Aparece solo cuando hay 3+ comparables con precio.
- **Trae TODOS los avisos reales, no solo los primeros**: C21 y RE/MAX pagan
  automáticamente hasta traer el catálogo completo de cada categoría (antes
  se cortaba en 200 y 60 avisos respectivamente — se estaba perdiendo hasta
  el 85% en categorías grandes como terreno. Corregido 2026-07-19, ver nota
  técnica más abajo).
- **Estado real de cada fuente, a la vista**: debajo del resumen de resultados
  aparece un chip verde ✓ por cada portal que respondió bien, o uno rojo
  "no disponible ahora" si alguno falló (bloqueo, error de red, etc.) —
  antes una fuente caída se mostraba como "0 resultados" sin explicar por
  qué, lo que hacía dudar si la app había buscado bien. Pasá el mouse por el
  chip rojo para ver el motivo exacto.
- **Contacto directo con el captador**: cada aviso de Century 21 muestra un botón
  "WhatsApp al captador" con el número real del asesor y un mensaje ya redactado.
  RE/MAX y BienInmuebles muestran el nombre del agente (contacto por su página).
- **IA (opcional, se activa con una API key)**: interpreta el pedido del cliente en
  lenguaje natural (texto o voz) y arma un resumen concreto de los resultados
  ("de 40, estas 3 son las mejores porque…"). Sin key, la app funciona igual con
  el intérprete local por reglas. Dos opciones de proveedor: **Google Gemini
  (gratis, recomendado para arrancar)** o Claude/Anthropic (de pago, mejor
  calidad) — ver "Activar la IA" más abajo.
- **Mapa de resultados**: botón "Ver en mapa" arriba de la lista — muestra
  todas las propiedades encontradas como pines en un mapa (Leaflet +
  OpenStreetMap, gratis, sin API key). Tocar un pin muestra precio, título y
  link directo al aviso.
- **Selector de zona real** (como el filtro de zona de RE/MAX o Century 21):
  el campo Zona tiene 14 chips con las zonas más buscadas (Norte, Este,
  Equipetrol, Urubó…) para tocar y sumar/sacar, más autocompletado al escribir
  con las 70 zonas reales de Santa Cruz que aparecen en los avisos de los 3
  portales — no una lista genérica, la vocabulario exacto que ya usan C21,
  RE/MAX y BienInmuebles, para que la zona elegida siempre matchee de verdad.
- **Búsqueda a medida**: filtra por m² de terreno y m² de construcción (mín/máx
  por separado), dormitorios y baños, además de zona y precio. Cada tarjeta
  muestra terreno y construcción por separado.
- Guarda requerimientos de clientes (operación, tipo, zona, precio, dormitorios).
  Cada uno se puede **editar** (botón "Editar" → carga los datos en el
  formulario, guarda con "Guardar cambios" sin crear un duplicado) o **borrar**.
- **Lee datos reales de Century 21, RE/MAX, BienInmuebles y Mobiliario App**
  y muestra las propiedades combinadas, con foto, precio, m², dormitorios,
  zona y la fuente de cada aviso. Ordenadas por precio. Mobiliario App
  (~7.900 propiedades, el catálogo más grande) se sincroniza en segundo
  plano — ver "Sobre Mobiliario App" más abajo.
- **Dictado por voz**: se toca el micrófono, se explica el requerimiento hablando
  ("terreno hasta Bs 900 mil sobre avenida en zona norte o este") y la app
  interpreta y llena el formulario solo (tipo, zonas, dormitorios, presupuesto,
  moneda Bs/US$, palabras clave). Usa la Web Speech API (Chrome/Edge).
- **Varias zonas a la vez**: la zona acepta lista separada por comas o "o/y"
  ("norte, este, Doble Vía a La Guardia"). Los puntos cardinales se matchean
  contra la zona estructurada del aviso (evita falsos positivos como "este"
  dentro de "oeste"); las zonas específicas (Equipetrol, Urubo…) por texto.
- **Presupuesto en Bs o US$**: los portales cotizan en dólares, así que si el
  presupuesto es en bolivianos se convierte con un tipo de cambio editable (por
  defecto 6.96; ajustable en el formulario). La conversión se muestra en pantalla.
- **Palabras clave** ("Debe mencionar"): ej. "avenida" — los avisos que las
  mencionan salen primero, marcados con ★. Con "Filtro estricto" activado,
  además descarta lo que no las menciona.
- **Excluir** ("No debe tener"): ej. "condominio" — descarta esos avisos de
  verdad (no solo los reordena). El dictado detecta negaciones ("fuera de",
  "sin", "no quiero") y las manda acá en vez de a "Debe mencionar".
- **Antigüedad máxima**: por defecto solo trae avisos de los últimos 90 días
  (editable). Cada tarjeta muestra "Publicado hace X días".
- **Tolerancia de presupuesto**: las opciones hasta un 12% fuera del rango
  exacto no se pierden — se muestran marcadas "Cerca del presupuesto", al
  final de la lista.
- **Alquiler y venta**, con precios normales para cada uno (los alquileres
  suelen costar bastante menos de US$1.000/mes — la app ya no los confunde con
  errores de tipeo, ver nota técnica más abajo).
- **Solo propiedades disponibles**: se descartan avisos que el propio portal
  marcó como dados de baja (vendidos, retirados). C21 y RE/MAX exponen un
  campo de estado y se verificó en vivo (2026-07-19, 460 avisos reales) que
  ambos endpoints ya solo traen activos — se agregó el chequeo explícito
  igual, por las dudas.
- Genera links directos a los portales que NO permiten lectura automática:
  **KW Bolivia, Facebook Ads, Facebook Marketplace, Grupos de Facebook y
  Google**. ⚠️ Estos son links que abren la búsqueda en cada sitio —
  la app NO trae esos resultados adentro. Facebook Marketplace no tiene API
  pública (no hay forma legítima de leerlo desde el servidor); Facebook Ads
  solo tiene API pública para anuncios políticos/sociales, no para inmobiliarias
  comunes. Ver la sección "Sobre Facebook / Marketplace" más abajo.

## Diseño

Pantalla oscura (azul marino + terracota/teal), tipografía del sistema (sin
fuentes externas, para no depender de un CDN). Formulario dividido en
secciones (Cliente, Qué busca, Presupuesto, Tamaño, Filtros finos) en vez de
un bloque único de campos.

**Actualizado 2026-07-22** — pasada de modernización: título con degradado de
color, botones con gradiente y sombra propia (en vez de color plano), radios
más redondeados (16px paneles, 20px modales), sombras con más profundidad y
con tinte del color de marca al hacer hover (en vez de negro plano), cards de
resultados con zoom suave de la imagen al pasar el mouse, íconos SVG propios
en vez de emoji en los botones principales (dictado, mapa, modo edición) —
se ven consistentes entre sistemas operativos, a diferencia del emoji.

## Cómo se usa

```
node server.js
```

Abrir http://localhost:3456. Los requerimientos quedan guardados en
`data/requerimientos.json` (o en un archivo por agente si activaste las keys —
ver abajo).

## Varios agentes con su propia cuenta (multiagente)

Por defecto la app corre en **modo abierto**: sin cuenta, un solo espacio de
datos — así funciona hoy para uso local de una persona, sin cambiar nada.

**Cada agente puede crearse su propia cuenta solo** (nombre + email +
contraseña), desde la pantalla de acceso de la app — no hace falta que José
Luis le cree una clave a mano. Apenas se registra el primer agente, la app
pasa sola a modo multiagente: todo `/api/*` exige sesión, y cada agente tiene
su propio archivo `data/requerimientos-<id>.json`, completamente separado del
resto — nadie ve ni edita los datos de otro agente.

La contraseña nunca se guarda en texto plano (hash scrypt nativo de Node, sin
dependencias). El login devuelve el mismo tipo de clave de acceso de siempre,
que el navegador guarda solo (`localStorage`) — no hay que volver a loguearse
cada vez que se abre la app.

**Alternativa — claves creadas por CLI** (para links de GHL, o agentes que
preferís dar de alta vos): sigue funcionando igual que antes:

```
node scripts/agentes.js crear "Nombre del agente"
node scripts/agentes.js listar
node scripts/agentes.js revocar <id>
node scripts/agentes.js activar <id>
```

El comando `crear` imprime un link con la clave (`https://tu-dominio/?key=sof_...`).
Al abrirlo, la app guarda la clave sola y ya no hace falta pegarla de nuevo —
o el agente también puede pegarla a mano desde "¿Tenés una clave de acceso?"
en la pantalla de acceso.

**Sobre "iniciar sesión con Google"**: técnicamente posible, pero necesita que
José Luis cree una credencial OAuth gratuita en Google Cloud Console (~5
minutos, trámite suyo — no se puede hacer por él). Queda pendiente si en
algún momento lo quiere sumar como opción extra sobre el sistema de cuentas
ya armado.

**Costo de la IA compartido:** si activaste la IA (ver abajo), todos los
agentes la usan con tu misma cuenta de Anthropic — el gasto es tuyo, no de
cada uno. Antes de repartir claves a mucha gente, tené presente eso.

## Usarlo desde el celular

**Opción rápida (misma wifi que tu compu, ahora mismo):** con la compu
prendida y `node server.js` corriendo, abrí en el navegador del celular
`http://<IP-de-tu-compu>:3456` (para ver esa IP: `ipconfig` en la compu,
buscar "Dirección IPv4" de la wifi). Solo funciona mientras el celular esté
en la misma red wifi que la compu.

**Para que se sienta una app de verdad** (ícono propio, sin barra de
navegador): una vez que la abriste en el celular, usá "Agregar a pantalla de
inicio" (Android: menú ⋮ → Agregar a pantalla de inicio; iPhone: botón
Compartir → Agregar a pantalla de inicio). Ya tiene el manifest e ícono
configurados para que abra en modo app.

**Para usarla desde cualquier lado (no solo en tu wifi)** hace falta
publicarla con una URL pública — ver abajo.

## Ponerlo accesible por internet (para usarlo fuera de casa, o integrarlo a GHL)

Hoy corre en tu compu (`localhost`) — accesible solo en tu wifi. Para
usarlo desde datos móviles, que otros agentes entren desde cualquier lado, o
para embeberlo dentro de GoHighLevel, la app tiene que estar en un hosting
con URL pública (HTTPS). Yo no puedo crear esa cuenta de hosting por vos,
pero el código ya está listo para desplegarse sin cambios (usa
`process.env.PORT`, trae `Procfile`).

**Pasos (con Railway, gratis para empezar):**
1. Crear cuenta en https://railway.app (con tu GitHub).
2. "New Project" → "Deploy from GitHub repo" → subir esta carpeta a un repo de
   GitHub y conectarlo (o usar `railway up` desde la terminal, sin GitHub).
3. En "Variables" del proyecto, cargar `ANTHROPIC_API_KEY` (si vas a usar IA).
4. Railway te da una URL pública tipo `https://buscador-inmuebles.up.railway.app`.
5. Los agentes se registran solos desde esa URL (ver "Varios agentes con su
   propia cuenta" más abajo) — no hace falta correr nada a mano.

**Importante — Volumen persistente**: Railway borra el filesystem del
contenedor en cada redeploy si no hay un volumen conectado — sin esto, cada
vez que se sube código nuevo se perderían todas las cuentas y requerimientos
guardados. Ya está configurado (`railway volume add --mount-path /app/data`,
un volumen de 500MB montado en `/app/data`) — verificado que los datos
sobreviven a un redeploy. Si alguna vez se recrea el proyecto desde cero en
Railway, hay que volver a crear este volumen ANTES de que agentes reales se
registren.

**Deploy real (ya en uso, 2026-07-23)**: la app publicada hoy en
`https://buscador-inmuebles-production.up.railway.app` se actualiza con
`railway up --ci -m "mensaje"` desde esta carpeta (requiere `railway login` y
`railway link` una vez). La detección automática de pushes a GitHub
("Check for updates") no está funcionando bien en este proyecto — devuelve
"GitHub Repo not found" de forma intermitente aunque el permiso ya está
concedido — así que por ahora **el deploy es manual con `railway up`**, no
automático al hacer `git push`. Si en el futuro se quiere arreglar eso,
revisar `railway service source connect --repo owner/repo --branch main`.

**Integrarlo en GHL — Custom Menu Link:**
1. En GHL → Configuración de la agencia/subcuenta → **Custom Menu Links**.
2. "Agregar link": nombre "Buscador de Inmuebles", URL = tu link con la key
   del agente (`https://tu-url/?key=sof_...`), marcar que abra dentro de GHL
   (iframe) si esa opción está disponible.
3. Cada agente necesita su propio Custom Menu Link con su propia key — GHL no
   tiene forma de pasar la key dinámicamente por usuario, así que si son
   muchos agentes conviene un link por agente (o repetir el mismo para todo
   un equipo que comparte una sola cuenta).

Esta parte (crear la cuenta de hosting, configurar el Custom Menu Link en GHL)
la hacés vos — son cambios de cuenta/UI que no puedo hacer por vos. Avisame
cuando tengas la URL pública y te ayudo a verificar que todo funcione ahí.

### Activar la IA (opcional)

**Opción gratis (recomendada para arrancar) — Google Gemini:**
1. Entrar a https://aistudio.google.com/apikey con una cuenta de Google y
   crear una key (gratis, sin tarjeta).
2. Copiar `.env.example` como `.env` y pegar la key en `GEMINI_API_KEY`.
3. Reiniciar (`node server.js`). Arriba del formulario debe decir "IA activa
   (gemini-flash-lite-latest, gratis)". No hace falta `npm install` — se
   llama por fetch directo, sin SDK.

**Opción de pago — Claude/Anthropic (mejor calidad, tiene costo por uso):**
1. Crear una API key en https://console.anthropic.com
2. Pegarla en `ANTHROPIC_API_KEY` en `.env` (se ignora si además hay una
   `GEMINI_API_KEY` cargada — Gemini tiene prioridad por ser gratis).
3. Instalar el SDK una sola vez: `npm install`.
4. Reiniciar. El modelo por defecto es `claude-opus-4-8`; para bajar costo,
   `AI_MODEL=claude-haiku-4-5` en `.env`.

La IA (con cualquiera de los dos proveedores) se usa en dos puntos: interpretar
el pedido (`/api/interpretar`) y resumir resultados (parámetro `resumir=1` en
la búsqueda). Si no hay ninguna key, la app avisa el motivo y sigue
funcionando igual con el intérprete local por reglas.

## Estado de las fuentes (verificado 2026-07-15)

| Fuente | Estado |
|---|---|
| **Century 21** (c21.com.bo) | Lectura automática. Misma URL de resultados + `?json=true`. Tipo terreno: `tipo_terreno`. Precio USD en `precios.vista.precio`; zona en `municipio`. 100 avisos/página |
| **RE/MAX** (remax.bo) | Lectura automática. API `remax.bo/api/search?city_id=4&subtype_property_ids[]=..&min_price=&max_price=&page=`. Santa Cruz = city_id 4. Terreno=101, Casa=161, Depto=131. 20 avisos/página |
| **BienInmuebles** (bieninmuebles.com.bo) | Lectura automática. Endpoint propio `common/php/procesos.php` (`proceso=getCatalogo`), POST sin login. 60 avisos/página. Incluye nombre del agente captador |
| Mobiliario App (mobiliario.app) | **No integrado a propósito** — 3.462 propiedades agregadas de toda Bolivia (más que las otras 3 fuentes juntas), pero su `robots.txt` tiene `Disallow: /api` explícito. Además usa Next.js con datos server-side (RSC), sin endpoint JSON estable como las otras fuentes → link directo |
| Bolivia Inmuebles (boliviainmuebles.com) | **No integrado a propósito** — su `robots.txt` bloquea explícitamente `User-agent: ClaudeBot` (a Claude, puntualmente, no una regla genérica anti-bot) → link directo, sin investigar más allá de eso |
| KW Bolivia (bolivia.kw.com) | Solo landing corporativa, sin buscador propio de listados → link directo |
| Facebook Marketplace | Link directo con ciudad fija (`/marketplace/santacruzdelasierra/`), muestra sin login |
| Facebook Ads (Biblioteca de Meta) | Link directo, anuncios activos en Bolivia (`?country=BO`) |
| Grupos de Facebook | Link directo a búsqueda de grupos |
| TikTok | Fuera de alcance — no es una plataforma de listados |
| InfoCasas / UltraCasas | **Descartados** (José Luis: ya no operan en Bolivia) |

## Sobre Facebook / Marketplace / TikTok

Marketplace, Grupos, Facebook Ads y TikTok **son links, no resultados traídos
por la app** — esto no es un bug a arreglar, es un límite real y deliberado:

- **Marketplace no tiene API pública de listados.** Las únicas formas de
  automatizarlo son (a) un scraper de terceros pago (Apify y similares,
  ~US$30–50/mes, se rompe seguido porque Facebook cambia el HTML) o (b) un
  navegador automatizado logueado, que **viola los términos de Facebook y
  puede bloquear la cuenta**. Ninguna de las dos es "segura" — no se
  implementan sin que lo decidas vos explícitamente, con el riesgo claro.
- **Facebook Ads Library tiene API oficial y gratuita, la investigué a fondo**
  — pero confirmé que solo cubre anuncios políticos/de temas sociales y
  ciertas categorías especiales de EE.UU. (vivienda, empleo, crédito). Los
  anuncios comerciales normales (como los de una inmobiliaria) **no están
  disponibles ahí ni con verificación de identidad** — no es un trámite
  pendiente, es una restricción dura de Meta. El único camino a "todos los
  anuncios" es el Content Library API, que va por un pipeline de investigador
  académico (CASD, Francia) — inviable para este uso.
- **Grupos de Facebook**: no tienen API de búsqueda en absoluto.
- **TikTok**: no es una plataforma de listados de propiedades — no hay
  estructura que buscar ahí, con o sin API.

Si en algún momento querés meterle presupuesto a un scraper de terceros para
Marketplace, avisame y lo evaluamos con el costo y riesgo real — pero no es
algo que arranque por mi cuenta.

## Sobre Mobiliario App (mobiliario.app)

**Integrado 2026-07-23** como cuarta fuente real — ~7.900 propiedades en
Bolivia (el catálogo más grande, más que las otras 3 fuentes juntas).

Su `robots.txt` sigue bloqueando explícitamente `/api` (verificado de nuevo,
no cambió desde julio) — eso NO se toca, y por eso no se lee su buscador
interno. Pero SÍ permite leer sus páginas de propiedades individuales
(`/listings/{id}`, no está en la lista de rutas bloqueadas) y cada una trae
un bloque de datos estructurados público estándar (schema.org JSON-LD — el
mismo formato que usa Google para indexar sitios), con precio, dormitorios,
baños, m², coordenadas. No es HTML frágil de adivinar: es un formato hecho
para lectura automática.

**Cómo funciona la integración** (distinto a las otras 3 fuentes, que
responden todo en una sola consulta):
- No hay búsqueda masiva, así que se sincroniza en **segundo plano**: se lee
  el `sitemap.xml` público (lista las ~7.900 propiedades), y se van pidiendo
  de a 4 en paralelo con una pausa entre tandas — ritmo de crawler normal,
  no una ráfaga. Se guarda en `data/cache-mobiliario.json`.
- Las búsquedas leen de esa caché (rápido, sin tocarle el servidor a
  mobiliario.app en cada búsqueda tuya).
- El progreso se guarda cada tanda — si el servidor se reinicia a mitad de
  una sincronización (pasa seguido en desarrollo), retoma solo lo que falte,
  no arranca de cero.
- Re-sincroniza sola cada 6 horas — no solo al arrancar el servidor, hay un
  chequeo cada hora (`setInterval`) mientras el proceso esté vivo. Antes solo
  se revisaba una vez al arrancar; si el servidor quedaba prendido varios
  días seguidos (lo normal en producción) nunca se volvía a chequear y los
  datos se congelaban — bug corregido 2026-07-24. Cada re-sincronización solo
  trae lo nuevo/modificado (comparando fechas del sitemap), mucho más rápido
  que la primera vez completa.
- **Limpia sola lo que ya no está disponible**: si una propiedad se vende o
  se da de baja en mobiliario.app, desaparece de su sitemap — en la siguiente
  sincronización se saca también de nuestra caché (antes se quedaba para
  siempre, otro bug corregido el mismo día).
- Si detecta muchos fallos seguidos (posible bloqueo, como pasó con
  BienInmuebles en julio), para sola en vez de insistir a ciegas.
- Solo se guardan propiedades de Santa Cruz (el portal cubre toda Bolivia,
  esta app está scopeada a Santa Cruz como las otras 3 fuentes).

**Limitación conocida**: el schema no trae fecha de publicación ni zona
estructurada (solo la ciudad) — la zona se arma del texto de la categoría, y
la búsqueda por zona igual funciona porque busca coincidencias en el título y
la descripción completa. Tampoco distingue bien la categoría boliviana
"anticrético" (depósito en garantía, ni venta ni alquiler tradicional) — hoy
se clasifica como venta por defecto si el título no dice "alquiler"
explícitamente; puede aparecer alguna propiedad en anticrético mezclada en
resultados de venta.

**Bug de moneda corregido (2026-07-23)**: varios avisos de esta fuente cotizan
en bolivianos (`offers.priceCurrency: "BOB"` en el schema), no todos en
dólares como se asumió al principio — se estaba tomando ese número
directamente como si fueran dólares, inflando el precio ~7x (una casa a
"Bs 10.440.000" se leía como "US$ 10.440.000"). Ahora se guarda el precio
crudo + la moneda tal cual en la sincronización, y la conversión a US$ pasa
recién en cada búsqueda con el tipo de cambio vigente — mismo criterio que
BienInmuebles. Si en el futuro hace falta forzar que la caché ya sincronizada
se vuelva a procesar entera (por un fix como este), usar el botón
"Forzar resincronización ahora" en `/admin.html`.

## Sobre Bolivia Inmuebles (boliviainmuebles.com)

Portal similar en propósito a este mismo buscador. José Luis pidió sumarlo
como fuente de datos. Su `robots.txt` tiene una entrada explícita
`User-agent: ClaudeBot` → `Disallow: /` — a diferencia de mobiliario.app
(bloqueo genérico de `/api`), acá el dueño del sitio nombró puntualmente a
Claude para que no lo lea. Es una señal directa dirigida a este asistente, no
una limitación técnica a investigar o esquivar — no se construyó ningún
scraper ni se investigó si existe un endpoint interno. Queda como link
directo. Igual que con mobiliario.app, un acuerdo de datos directo con ellos
sería un camino legítimo si en algún momento interesa.

## Notas técnicas

- Node puro, sin dependencias (requiere Node 18+; probado con v24).
- **Paginación dinámica (2026-07-19)**: antes C21 solo pedía 2 páginas (200
  avisos) y RE/MAX 3 (60 avisos) — un límite fijo puesto al principio, sin
  pensar que categorías populares (terreno, casa) tienen 700-1.350 avisos
  reales. Ahora se lee el total real que cada portal devuelve (C21:
  `totalHits`; RE/MAX: `last_page`, paginación estándar) y se piden todas las
  páginas necesarias, con techo de seguridad (C21: 20 páginas = 2.000 avisos;
  RE/MAX: 40 páginas = 800). BienInmuebles no expone un total, así que pide
  página por página (una a la vez, no en ráfaga) hasta que una página vuelve
  incompleta — así llega también al final real sin necesitar un endpoint
  aparte (ver nota del bloqueo más abajo). Resultado verificado: casa en
  venta C21 200→997, RE/MAX 60→660; terreno C21 1.342/1.350 (prácticamente
  completo). **Consecuencia esperada**: las búsquedas ahora tardan más (3-7
  segundos en vez de 1-2) porque hay más para traer — es el trade-off de
  tener el catálogo completo en vez de una muestra.
- **Zonas con tilde arregladas (2026-07-19)**: el filtro de zona no ignoraba
  tildes — "Urubó" (como lo escribe RE/MAX) no encontraba los avisos de C21
  que dicen "Urubo" sin tilde, y dejaba ese chip del selector en 0 resultados
  falsos. Ahora compara sin tildes en ambos lados, así cualquier variante
  (con o sin acento) encuentra lo mismo. Mismo arreglo aplicado también a
  "Debe mencionar" y "Excluir", por consistencia.
- **Fallos por fuente ya no se tragan en silencio (2026-07-19)**: si C21,
  RE/MAX o BienInmuebles fallan (bloqueo anti-bot, error de red, respuesta
  rara), antes la búsqueda igual mostraba "0 resultados" de esa fuente sin
  avisar — parecía que la app había buscado bien cuando en realidad una
  fuente entera no respondió. Ahora se guarda el motivo real de cada fuente
  (`estadoFuentes` en la respuesta de `/api/buscar`) y se muestra en la
  interfaz como un chip verde/rojo por portal.
- **BienInmuebles bloqueado temporalmente (desde 2026-07-19)**: el sitio usa
  protección anti-bot (Imunify360) y empezó a devolver "Access denied" —
  causado por una ráfaga de pruebas que hice ese día investigando zonas
  (~20 pedidos seguidos). La app lo maneja bien (0 resultados de esa fuente,
  no rompe nada), pero mientras dure el bloqueo esa fuente no aporta avisos.
  No se sabe cuánto dura — hay que verificar más adelante si se levantó solo.
- Los precios aceptan "65.000", "65,000" o "65000" (separadores de miles).
- Precios de C21/RE/MAX se normalizan a US$. Se descartan precios implausibles
  (errores de tipeo) con un umbral que **depende de la operación**: para venta,
  menos de US$1.000 (ej. una casa a "US$78"); para **alquiler**, menos de
  US$10 — los alquileres reales suelen costar 150-900 USD/mes, así que el
  umbral de venta los borraba a todos por error (bug corregido 2026-07-15).
- El filtro de "antigüedad máxima" **no descarta** avisos sin fecha conocida
  (BienInmuebles no expone fecha de publicación) — antes sí los descartaba, lo
  que borraba en silencio el 100% de BienInmuebles en cada búsqueda con el
  filtro activo, que además es el valor por defecto del formulario (90 días).
  Bug corregido 2026-07-19.
- Verificado en vivo que C21 y RE/MAX exponen campo de estado del aviso
  (`enInternet`/`status_listing`) y que su endpoint de búsqueda solo devuelve
  activos (0 vendidos en 460 avisos de muestra) — se agregó el filtro
  explícito en el código igual, para no depender solo de la observación.
- Los 3 portales exponen coordenadas (lat/lon) por aviso — se usan para el
  mapa. C21: `lat`/`lon`. RE/MAX: `location.latitude`/`location.longitude`.
  BienInmuebles: `latitud_cata`/`longitud_cata`.
- La lista de 70 zonas (`/api/zonas`) se extrajo de los campos reales de zona
  de los 3 portales (C21: `municipio`; RE/MAX: `location.zone.name`;
  BienInmuebles: `nomb_barri`), no de una fuente externa — así el selector
  nunca ofrece una zona que no exista en los datos.
- Tolerancia de presupuesto: se pide con un 12% de margen a los portales y se
  filtra localmente, marcando "cerca del presupuesto" lo que queda fuera del
  rango exacto pero dentro del margen (en vez de perderlo).
- Cada portal se consulta en paralelo; si uno falla, el otro igual responde.

## Mejoras pendientes

- BienInmuebles: capturar su endpoint AJAX para lectura real.
- Más páginas de C21/RE/MAX si hacen falta más resultados por zona.
- Alertas automáticas cuando aparezca una propiedad nueva que coincida con un
  requerimiento guardado.
- Marcar propiedades como "enviada al cliente" / "descartada".
- Panel para crear/revocar claves de agentes desde la web (hoy es por CLI,
  `scripts/agentes.js`, para no exponer esa acción como endpoint público).
- Si el equipo crece mucho, dar a cada agente su propia key de Anthropic en
  vez de compartir la tuya (hoy el gasto de IA es todo con tu cuenta).

## Panel de administración (/admin.html)

Página aparte para José Luis — ver quién se registró y cuánto se usa la app,
sin necesitar la terminal (útil sobre todo para el deploy público, donde no
se puede correr `scripts/agentes.js` directo contra los datos remotos).

- Gateado con `ADMIN_KEY` (variable de entorno, separada de las cuentas de
  agente — no hace falta "ser un agente" para entrar acá).
- Muestra: nombre, email, cómo se dio de alta (cuenta propia o clave por
  CLI), fecha de registro, cuántos requerimientos tiene guardados cada uno,
  y un botón para activar/revocar la cuenta ahí mismo.
- Visitas: contador simple por día (sin IP ni nada identificable de la
  persona — solo cuántas veces se abrió la página principal).

## Seguridad de las claves

- `data/agentes.json` tiene las claves en texto plano — está en `.gitignore`,
  nunca lo subas a un repo público. Las contraseñas de las cuentas propias
  (registro/login) sí están hasheadas (scrypt), pero las `apiKey` en sí son
  tokens en texto plano, como cualquier API key.
- Una clave revocada (desde `/admin.html` o `node scripts/agentes.js revocar <id>`)
  deja de funcionar al toque; el agente ve la pantalla de acceso de nuevo.
- Los datos de cada agente quedan en su propio archivo
  (`data/requerimientos-<id>.json`) — borrar ese archivo borra sus
  requerimientos sin tocar los de otros agentes.
