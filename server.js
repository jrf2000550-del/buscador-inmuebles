// Buscador de inmuebles — Sofymar IA
// Lee datos reales de Century 21, RE/MAX y BienInmuebles Bolivia (APIs
// internas de cada sitio) y genera links directos a KW Bolivia y Facebook
// (Ads, Marketplace, Grupos) — portales que no permiten lectura automática.
// Sin dependencias: solo Node >= 18.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Carga simple de .env (para la API key de IA), sin dependencias.
(function cargarEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const linea of txt.split('\n')) {
      const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
})();

const PORT = process.env.PORT || 3456;
// Para armar links absolutos (páginas de presentación de propiedades) en los
// mensajes que se le mandan al cliente por WhatsApp.
const BASE_URL_APP = process.env.APP_BASE_URL || 'https://buscador-inmuebles-production.up.railway.app';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requerimientos.json');
const AGENTES_FILE = path.join(DATA_DIR, 'agentes.json');
const VISITAS_FILE = path.join(DATA_DIR, 'visitas.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Bug real encontrado 2026-08-25 (José Luis: "no está disponible C21,
// BienInmuebles y RE/MAX" al mismo tiempo, en local): ninguno de los fetch
// a portales tenía timeout — si UNA sola conexión se colgaba (más probable
// ahora que RMX_PAGINAS_MAX subió a 80 pedidos en paralelo), toda la
// búsqueda quedaba esperando para siempre en vez de fallar y avisar. Node
// 18+ trae `AbortSignal.timeout()` nativo, sin librerías — se lo pasamos a
// TODOS los fetch a portales, así cualquier conexión trabada corta sola a
// los 15s y cae en el manejo de error que ya existía (por página, no rompe
// toda la fuente; en la página 1, se reporta como "no disponible" en vez
// de colgar el pedido entero).
const FETCH_TIMEOUT_MS = 15000;

const TIPOS = new Set([
  'casa', 'departamento', 'terreno', 'local', 'oficina',
  'quinta', 'terreno-comercial', 'edificio', 'deposito', 'tinglado',
  'rural', 'rancho', 'agricolas', 'ganaderas', 'cochera', 'hotel', 'colegio', 'proyecto',
]);
// camposRequerimiento (más abajo) cae en silencio a 'casa' si el tipo
// recibido no está en este Set — cualquier tipo nuevo que se agregue acá
// también tiene que sumarse acá, si no queda guardado mal sin avisar.
const APLICA_DORMITORIOS = new Set(['casa', 'departamento', 'quinta']);
// Tipos donde lo relevante para comparar precio/m² es el terreno, no la
// construcción — mismo criterio que ya usaba 'terreno' solo, extendido a los
// tipos nuevos que también son "tierra" ante todo. 'quinta' queda afuera
// (se trata como casa: tiene construcción propia, no solo lote).
const TIPOS_TERRENO = new Set(['terreno', 'terreno-comercial', 'rural', 'rancho', 'agricolas', 'ganaderas']);

// Zonas reales de Santa Cruz de la Sierra, extraídas directo de los avisos de
// Century 21, RE/MAX y BienInmuebles (no de una lista genérica de internet) —
// así el selector de zona SIEMPRE ofrece nombres que existen de verdad en los
// avisos, evitando que el agente escriba una zona que no matchea nada.
// Investigado 2026-07-19 sobre ~950 avisos reales (varios tipos/operaciones);
// orden = frecuencia de aparición (las primeras son las más buscadas/comunes).
const ZONAS = [
  'Norte', 'Este', 'Sur', 'Equipetrol', 'Urubó', 'Equipetrol/NorOeste',
  'Carretera Norte', 'Oeste', 'Doble Vía La Guardia', 'Banzer km9 y km10',
  'Sureste', 'Urbari', 'Centro', 'Suroeste', 'Norte Entre 8vo y 9no anillo',
  'Plan 3000', 'Pampa de la Isla', 'Sur Entre 6to y 7mo anillo',
  'Este Entre 7mo y 8vo anillo', 'Las Palmas', 'Carretera Cotoca', 'Cotoca',
  'Norte Entre 3er y 4to anillo', 'Norte Entre 1er y 2do anillo',
  'Sur Entre 8vo y 9no anillo', 'Noreste', 'Norte Entre 2do y 3er anillo',
  'Sirari', 'Banzer 5to a 7mo anillo', 'La Cuchilla', 'Centro (Casco Viejo)',
  'Parque Urbano', 'Av. Virgen de Luján', 'El Quior', 'Noroeste',
  'Norte Entre 6to y 7mo anillo', 'El Remanso', 'Oeste Entre 3er y 4to anillo',
  'Trompillo', 'Villa 1ro de Mayo', 'Av. Virgen de Cotoca',
  'Sur Entre 7mo y 8vo anillo', 'Este Entre 4to y 5to anillo',
  'Entre 1er y 2do anillo', 'Hamacas', 'Este Entre 3er y 4to anillo',
  'Oeste Entre 9no y 10mo anillo', 'Santos Dumont', 'Ovidio Barbery', 'Pirai',
  'Distrito 12', 'El Palmar', 'Sur Entre 3er y 4to anillo', 'Pailón',
  'Norte Entre 4to y 5to anillo', 'Este Entre 1er y 2do anillo',
  'Sur Entre 4to y 5to anillo', 'Oeste Entre 4to y 5to anillo',
  'Este Entre 5to y 6to anillo', 'Ciudadelas', 'Los Pozos', 'Mutualista',
  'Warnes', 'Banzer 3er al 5to anillo', 'Radial 26', 'Este Entre 6to y 7mo anillo',
  'Oeste Entre 7mo y 8vo anillo', 'Ñuflo de Chávez', 'Alemana',
  'Banzer 7mo a 9no anillo',
];
// Las más buscadas van primero como accesos rápidos (chips); el resto queda
// disponible igual por autocompletado (datalist) en el campo de texto.
const ZONAS_RAPIDAS = ZONAS.slice(0, 14);

// ---------- Multi-agente (keys de acceso) ----------
// Sin agentes registrados: la app funciona en modo abierto (como antes, sin
// key, un solo espacio de datos) — así el uso local de José Luis no cambia.
// Apenas se crea un agente con scripts/agentes.js, la app exige X-Api-Key en
// todo /api/* y separa los requerimientos de cada agente en su propio archivo.

function leerAgentes() {
  try {
    return JSON.parse(fs.readFileSync(AGENTES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function guardarAgentes(lista) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AGENTES_FILE, JSON.stringify(lista, null, 2));
}

function modoMultiagente() {
  return leerAgentes().some((a) => a.activo !== false);
}

function autenticar(req) {
  const key = req.headers['x-api-key'];
  if (!key) return null;
  return leerAgentes().find((a) => a.apiKey === key && a.activo !== false) || null;
}

// ---------- Cuentas propias (registro/login, además de las keys por CLI) ----------
// Cada agente crea su propia cuenta (nombre + email + contraseña) en vez de
// pedirle la clave a José Luis — la contraseña nunca se guarda en texto
// plano (scrypt + sal, nativo de Node, sin dependencias). El resultado sigue
// siendo el mismo apiKey de siempre (mismo aislamiento de datos por agente
// que ya existía) — el registro/login son solo una forma más fácil de
// conseguir esa key, no un sistema aparte.

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verificarPassword(password, salt, hash) {
  const intento = crypto.scryptSync(password, salt, 64).toString('hex');
  const bufIntento = Buffer.from(intento, 'hex');
  const bufReal = Buffer.from(hash, 'hex');
  return bufIntento.length === bufReal.length && crypto.timingSafeEqual(bufIntento, bufReal);
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function registrarAgente({ nombre, email, password, inmobiliaria, oficina }) {
  nombre = String(nombre || '').trim();
  email = String(email || '').trim().toLowerCase();
  if (!nombre) throw new Error('Falta el nombre.');
  if (!emailValido(email)) throw new Error('El email no es válido.');
  if (!password || password.length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');

  const lista = leerAgentes();
  if (lista.some((a) => (a.email || '').toLowerCase() === email)) {
    throw new Error('Ya existe una cuenta con ese email.');
  }
  const { salt, hash } = hashPassword(password);
  const nuevo = {
    id: crypto.randomBytes(4).toString('hex'),
    nombre,
    email,
    inmobiliaria: String(inmobiliaria || '').trim(),
    oficina: String(oficina || '').trim(),
    passwordSalt: salt,
    passwordHash: hash,
    apiKey: 'sof_' + crypto.randomBytes(24).toString('hex'),
    creado: new Date().toISOString(),
    activo: true,
  };
  lista.push(nuevo);
  guardarAgentes(lista);
  return nuevo;
}

function loginAgente({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const lista = leerAgentes();
  const agente = lista.find((a) => (a.email || '').toLowerCase() === email && a.activo !== false);
  // Mismo mensaje de error para "no existe" y "contraseña incorrecta" — no
  // hay que darle pistas a quien intenta entrar de que un email existe o no.
  const credencialesInvalidas = () => new Error('Email o contraseña incorrectos.');
  if (!agente || !agente.passwordHash) throw credencialesInvalidas();
  if (!verificarPassword(password || '', agente.passwordSalt, agente.passwordHash)) throw credencialesInvalidas();
  return agente;
}

// ---------- Panel de administración (José Luis) ----------
// Separado del sistema de agentes: una key de admin (ADMIN_KEY en .env),
// distinta de las apiKey de cada agente — José Luis no necesita "ser un
// agente" para ver quién se registró y cuánto se usa la app.

function esAdmin(req) {
  const key = req.headers['x-admin-key'];
  return !!process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
}

// Visitas: solo un contador por día (sin IP, sin nada identificable de la
// persona) — alcanza para ver el pulso de uso sin guardar datos sensibles.
function leerVisitas() {
  try {
    return JSON.parse(fs.readFileSync(VISITAS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function registrarVisita() {
  const hoy = new Date().toISOString().slice(0, 10);
  const visitas = leerVisitas();
  visitas[hoy] = (visitas[hoy] || 0) + 1;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VISITAS_FILE, JSON.stringify(visitas));
}

// ---------- Almacenamiento de requerimientos ----------

function archivoRequerimientos(agenteId) {
  return agenteId ? path.join(DATA_DIR, `requerimientos-${agenteId}.json`) : DATA_FILE;
}

function leerRequerimientos(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoRequerimientos(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

function guardarRequerimientos(lista, agenteId) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(archivoRequerimientos(agenteId), JSON.stringify(lista, null, 2));
}

// ---------- Inventario propio (por agente, aislado igual que requerimientos) ----------
// Dos categorías dentro del mismo archivo: 'mio' (propiedades propias del
// agente) y 'otro' (captaciones de otros agentes que él va anotando a mano,
// aunque esos otros agentes ni usen la app — es su base de datos personal,
// NO un pool compartido entre los agentes de la plataforma).

function archivoInventario(agenteId) {
  return path.join(DATA_DIR, `inventario-${agenteId}.json`);
}

function leerInventario(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoInventario(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

// Red entre agentes: cualquier agente logueado puede CONSULTAR (nunca
// escribir) el inventario "mio"/disponible de los demás — mismo nivel de
// detalle que ya es público en la vitrina de cada uno, así que no es una
// exposición nueva, solo una forma de encontrarlo sin tener el link. La
// seguridad de escritura no depende de esta función: cada endpoint de
// escritura de inventario sigue usando el agenteId de la propia sesión
// autenticada, nunca uno pasado en la consulta — así que ver esto acá no
// abre ninguna puerta para alterar datos de otro agente.
function leerInventarioDeTodosLosAgentes(excluirAgenteId) {
  const resultado = [];
  for (const agente of leerAgentes()) {
    if (agente.id === excluirAgenteId || agente.activo === false) continue;
    const propias = leerInventario(agente.id)
      .filter((i) => i.categoria === 'mio' && i.estado === 'disponible')
      .map((i) => ({
        titulo: i.titulo, tipo: i.tipo, operacion: i.operacion, precio: i.precio, zona: i.zona,
        dormitorios: i.dormitorios, banos: i.banos, m2Terreno: i.m2Terreno, m2Construccion: i.m2Construccion,
        descripcion: i.descripcion, agenteNombre: agente.nombre, agenteTelefono: agente.telefonoContacto || '',
      }));
    resultado.push(...propias);
  }
  return resultado;
}

function guardarInventario(lista, agenteId) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(archivoInventario(agenteId), JSON.stringify(lista, null, 2));
}

// Normaliza el body de un ítem de inventario (crear/editar) — mismo criterio
// que camposRequerimiento: una sola función para los dos caminos.
function camposInventario(body) {
  return {
    categoria: body.categoria === 'otro' ? 'otro' : 'mio',
    titulo: (body.titulo || '(sin título)').trim(),
    descripcion: (body.descripcion || '').trim(),
    operacion: body.operacion === 'alquiler' ? 'alquiler' : 'venta',
    tipo: TIPOS.has(body.tipo) ? body.tipo : 'casa',
    precio: parsePrecio(body.precio),
    zona: (body.zona || '').trim(),
    direccion: (body.direccion || '').trim(),
    dormitorios: body.dormitorios ? Number(body.dormitorios) : null,
    banos: body.banos ? Number(body.banos) : null,
    m2Terreno: body.m2Terreno ? Number(body.m2Terreno) : null,
    m2Construccion: body.m2Construccion ? Number(body.m2Construccion) : null,
    // Solo aplica de verdad cuando categoria==='otro' — quién captó la
    // propiedad, para poder preguntarle si sigue disponible.
    captadorNombre: (body.captadorNombre || '').trim(),
    captadorTelefono: (body.captadorTelefono || '').trim(),
    estado: ['disponible', 'vendido', 'no_disponible'].includes(body.estado) ? body.estado : 'disponible',
    // Carpeta de Google Drive ya organizada por el agente — de ahí se
    // resuelven las fotos automáticamente, sin subir nada a mano.
    fotosCarpetaDrive: (body.fotosCarpetaDrive || '').trim(),
  };
}

// Fotos automáticas desde la carpeta de Drive de cada propiedad. Requiere
// GOOGLE_API_KEY (una API key de Google Cloud restringida a la Drive API —
// NO hace falta OAuth porque la carpeta ya está compartida como "cualquiera
// con el link puede ver"). Sin esa key configurada, el campo se guarda igual
// pero no se resuelven fotos (no rompe nada, solo queda pendiente).
function idCarpetaDrive(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

async function listarArchivosDrive(folderId) {
  if (!process.env.GOOGLE_API_KEY) return [];
  try {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100&key=${process.env.GOOGLE_API_KEY}`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.files || [];
  } catch {
    return [];
  }
}

// Muchos agentes no ponen las fotos sueltas en la carpeta de la propiedad,
// sino organizadas en sub-subcarpetas propias (ej. "Exterior"/"Interior"),
// y a veces el PDF (ficha/brochure) está en otra subcarpeta distinta a la
// de las fotos — así que fotos y PDF se buscan CADA UNO por separado un
// nivel más adentro si no aparecen directo, no se detienen la búsqueda de
// uno solo porque ya se encontró el otro.
async function recolectarArchivosCarpeta(folderId, profundidad = 1) {
  const archivos = await listarArchivosDrive(folderId);
  const imagenesDirectas = archivos.filter((f) => f.mimeType && f.mimeType.startsWith('image/'));
  const pdfDirecto = archivos.find((f) => f.mimeType === 'application/pdf');
  const subs = archivos.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');

  let fotos = imagenesDirectas.map((f) => `https://drive.google.com/thumbnail?id=${f.id}&sz=w1200`);
  let pdfId = pdfDirecto ? pdfDirecto.id : null;

  if ((!fotos.length || !pdfId) && profundidad > 0) {
    for (const sub of subs) {
      if (fotos.length && pdfId) break;
      const r = await recolectarArchivosCarpeta(sub.id, profundidad - 1);
      if (!fotos.length) fotos = r.fotos;
      if (!pdfId) pdfId = r.pdfId;
    }
  }
  return { fotos, pdfId };
}

async function resolverFotosCarpeta(folderId, profundidad = 1) {
  return (await recolectarArchivosCarpeta(folderId, profundidad)).fotos;
}

async function resolverFotosDrive(carpetaUrl) {
  const id = idCarpetaDrive(carpetaUrl);
  if (!id || !process.env.GOOGLE_API_KEY) return [];
  return resolverFotosCarpeta(id, 1);
}

// Descarga el contenido crudo de un archivo público de Drive (sirve para
// PDFs, igual que las fotos: la carpeta ya está compartida "cualquiera con
// el link puede ver", así que una API key alcanza, sin OAuth).
async function descargarArchivoDrive(fileId) {
  if (!process.env.GOOGLE_API_KEY) return null;
  try {
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${process.env.GOOGLE_API_KEY}`);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// Lee el PDF (ficha/brochure) de la propiedad con Gemini (soporta PDFs
// nativamente, sin librería de parseo) y extrae precio/características —
// así el agente no tiene que tipear nada si ya tiene una ficha en la
// carpeta. Solo con Gemini (gratis); si solo hay Claude configurado, se
// omite esta extracción (no rompe nada, el campo queda pendiente).
const PROMPT_EXTRAER_FICHA =
  'Sos un asistente que extrae datos de una ficha/brochure de una propiedad inmobiliaria en Bolivia. ' +
  'Del documento adjunto extraé SOLO lo que esté explícito ahí — nunca inventes ni asumas un valor. ' +
  'Devolvé JSON con EXACTAMENTE estas claves (null si no aparece en el documento): precio (número en ' +
  'USD, sin símbolos ni puntos de miles), m2Terreno (número), m2Construccion (número), dormitorios ' +
  '(número), banos (número), zona (string corto, el barrio o zona), descripcion (string corto, 1-2 frases).';

async function extraerFichaConIA(fileId) {
  if (!process.env.GEMINI_API_KEY || !fileId) return null;
  const buffer = await descargarArchivoDrive(fileId);
  if (!buffer) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: PROMPT_EXTRAER_FICHA }, { inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    };
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function listarSubcarpetasDrive(raizId) {
  if (!process.env.GOOGLE_API_KEY) return [];
  try {
    const q = encodeURIComponent(`'${raizId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=200&key=${process.env.GOOGLE_API_KEY}`
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.files || [];
  } catch {
    return [];
  }
}

// Adivina tipo/operación a partir de nombres de carpeta (propiedad primero,
// categoría como respaldo) — José Luis organiza su Drive con carpetas de
// categoría ("TERRENOS", "ALQUILER") que contienen las carpetas de cada
// propiedad, así que el nombre de la propiedad manda si tiene una pista
// propia, y si no, se usa la de la carpeta que la contiene.
// Orden importa: cuando una carpeta de categoría es ambigua (ej.
// "DEPARTAMENTOS/OFICINAS" contiene ambas palabras), gana la primera que
// matchea — "departamento" va antes que "oficina" porque en la práctica
// la mayoría de esas carpetas mixtas son edificios de departamentos.
const PISTAS_TIPO = [
  [/quinta/i, 'quinta'], [/terreno/i, 'terreno'], [/departamento/i, 'departamento'], [/edificio/i, 'edificio'],
  [/oficina/i, 'oficina'], [/dep[oó]sito|galp[oó]n/i, 'deposito'],
  [/local/i, 'local'], [/rancho/i, 'rancho'], [/hotel/i, 'hotel'], [/colegio/i, 'colegio'],
  [/cochera/i, 'cochera'], [/casa/i, 'casa'],
];
function detectarTipo(nombre) {
  for (const [regex, tipo] of PISTAS_TIPO) if (regex.test(nombre)) return tipo;
  return null;
}
function adivinarTipo(...nombres) {
  for (const n of nombres) {
    const t = detectarTipo(n);
    if (t) return t;
  }
  return 'casa';
}
function adivinarOperacion(...nombres) {
  return nombres.some((n) => /alquiler/i.test(n)) ? 'alquiler' : 'venta';
}

// Sincronización de un toque: el agente conecta UNA sola carpeta raíz de su
// Drive. Escanea 2 niveles: si una carpeta de nivel 1 tiene subcarpetas, cada
// subcarpeta es una propiedad (carpeta de categoría, ej. "TERRENOS" con una
// carpeta por terreno adentro); si no tiene subcarpetas pero sí fotos propias,
// la carpeta de nivel 1 ES la propiedad (ej. "QUINTA EL ABUELO" suelta en la
// raíz). El match con ítems ya creados es por driveFolderId (no por título),
// así una resincronización nunca pisa lo que el agente ya completó a mano —
// solo refresca fotos. Además, si una sincronización anterior (antes de este
// arreglo) había creado un ítem para una carpeta que en realidad es de
// categoría, se lo saca acá para no dejar duplicados sueltos.
async function sincronizarInventarioDesdeDrive(agenteId) {
  const agente = leerAgentes().find((a) => a.id === agenteId);
  const raizId = agente && idCarpetaDrive(agente.driveRaizUrl);
  if (!raizId) return { error: 'No hay una carpeta raíz de Drive configurada.' };

  const nivel1 = await listarSubcarpetasDrive(raizId);
  const propiedades = [];
  for (const cat of nivel1) {
    const subcarpetas = await listarSubcarpetasDrive(cat.id);
    if (subcarpetas.length) {
      for (const prop of subcarpetas) {
        propiedades.push({
          folderId: prop.id,
          nombre: prop.name,
          tipo: adivinarTipo(prop.name, cat.name),
          operacion: adivinarOperacion(prop.name, cat.name),
        });
      }
    } else {
      const directo = await recolectarArchivosCarpeta(cat.id, 0);
      if (directo.fotos.length || directo.pdfId) {
        propiedades.push({
          folderId: cat.id,
          nombre: cat.name,
          tipo: adivinarTipo(cat.name),
          operacion: adivinarOperacion(cat.name),
          fotos: directo.fotos,
          pdfId: directo.pdfId,
        });
      }
    }
  }

  const idsValidos = new Set(propiedades.map((p) => p.folderId));
  let lista = leerInventario(agenteId).filter((i) => !i.driveFolderId || idsValidos.has(i.driveFolderId));

  let creados = 0;
  let actualizados = 0;
  for (const prop of propiedades) {
    const recolectado = prop.fotos !== undefined ? prop : await recolectarArchivosCarpeta(prop.folderId, 1);
    const fotos = recolectado.fotos;
    const pdfId = recolectado.pdfId;
    const idx = lista.findIndex((i) => i.driveFolderId === prop.folderId);
    if (idx === -1) {
      // Si hay una ficha/brochure en PDF, la IA la lee y completa precio y
      // características — el agente no tiene que tipear nada si ya la subió.
      const extraido = pdfId ? await extraerFichaConIA(pdfId) : null;
      lista.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        creado: new Date().toISOString(),
        ultimaConfirmacion: new Date().toISOString(),
        comentarios: [],
        categoria: 'mio',
        titulo: prop.nombre,
        descripcion: extraido?.descripcion || '',
        operacion: prop.operacion,
        tipo: prop.tipo,
        precio: extraido?.precio ?? null,
        zona: extraido?.zona || '',
        direccion: '',
        dormitorios: extraido?.dormitorios ?? null,
        banos: extraido?.banos ?? null,
        m2Terreno: extraido?.m2Terreno ?? null,
        m2Construccion: extraido?.m2Construccion ?? null,
        captadorNombre: '',
        captadorTelefono: '',
        estado: 'disponible',
        driveFolderId: prop.folderId,
        fotosCarpetaDrive: `https://drive.google.com/drive/folders/${prop.folderId}`,
        fotos,
        fichaPdfId: pdfId,
        historialPrecios: extraido?.precio != null ? [{ precio: extraido.precio, fecha: new Date().toISOString() }] : [],
      });
      creados++;
    } else {
      // Resincronización: solo completa lo que todavía está vacío — nunca
      // pisa datos que el agente ya cargó o corrigió a mano.
      const actual = lista[idx];
      const cambios = { fotos, fichaPdfId: pdfId };
      if (pdfId && actual.precio == null) {
        const extraido = await extraerFichaConIA(pdfId);
        if (extraido) {
          if (extraido.precio != null) {
            cambios.precio = extraido.precio;
            cambios.historialPrecios = [...(actual.historialPrecios || []), { precio: extraido.precio, fecha: new Date().toISOString() }];
          }
          if (extraido.zona && !actual.zona) cambios.zona = extraido.zona;
          if (extraido.descripcion && !actual.descripcion) cambios.descripcion = extraido.descripcion;
          if (extraido.dormitorios != null && actual.dormitorios == null) cambios.dormitorios = extraido.dormitorios;
          if (extraido.banos != null && actual.banos == null) cambios.banos = extraido.banos;
          if (extraido.m2Terreno != null && actual.m2Terreno == null) cambios.m2Terreno = extraido.m2Terreno;
          if (extraido.m2Construccion != null && actual.m2Construccion == null) cambios.m2Construccion = extraido.m2Construccion;
        }
      }
      lista[idx] = { ...actual, ...cambios };
      actualizados++;
    }
  }
  guardarInventario(lista, agenteId);
  if (creados || actualizados) {
    registrarActividadInventario(agenteId, 'sync-drive', { creados, actualizados });
  }
  return { ok: true, carpetas: propiedades.length, creados, actualizados };
}

// Corre matcheaPropiedad contra los requerimientos guardados DEL MISMO
// agente (a diferencia de matchearContraTodosLosAgentes, acá no cruza entre
// agentes — el inventario es personal) y genera una alerta por cada match.
function matchearInventarioConRequerimientos(item, agenteId) {
  if (item.estado !== 'disponible') return [];
  const candidatos = leerRequerimientos(agenteId).filter(
    (r) => r.tipo === item.tipo && r.operacion === item.operacion
  );
  const matches = candidatos.filter((r) => matcheaPropiedad({ ...item }, r));
  return matches.map((r) =>
    guardarAlerta(agenteId, {
      tipo: 'match_inventario',
      origen: item.categoria === 'otro' ? 'inventario-otro' : 'inventario-propio',
      propiedad: { id: item.id, titulo: item.titulo, precio: item.precio, zona: item.zona, tipo: item.tipo, operacion: item.operacion },
      requerimiento: { id: r.id, cliente: r.cliente, telefono: r.telefono, zona: r.zona, precioMin: r.precioMin, precioMax: r.precioMax },
    })
  );
}

// ---------- Feedback de agentes ----------
// Un solo archivo compartido (no por agente, a diferencia de requerimientos/
// alertas) porque José Luis lo revisa todo junto en el panel admin.

const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');

function leerFeedback() {
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function guardarFeedbackLista(lista) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(lista, null, 2));
}

// ---------- Actividad de inventario (para el panel admin de José Luis) ----------
// Un solo archivo compartido, igual que feedback: José Luis quiere ver de
// un vistazo cuándo un agente (Ingrid, Lizett, etc.) agrega o actualiza una
// captación en su propio inventario, sin tener que entrar a revisar cuenta
// por cuenta.

const ACTIVIDAD_INVENTARIO_FILE = path.join(DATA_DIR, 'actividad-inventario.json');

function leerActividadInventario() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVIDAD_INVENTARIO_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function guardarActividadInventario(lista) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACTIVIDAD_INVENTARIO_FILE, JSON.stringify(lista, null, 2));
}

function registrarActividadInventario(agenteId, accion, detalle) {
  const agente = leerAgentes().find((a) => a.id === agenteId);
  const lista = leerActividadInventario();
  lista.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agenteId,
    agenteNombre: agente ? agente.nombre : 'Agente',
    accion, // 'creado' | 'actualizado' | 'sync-drive'
    detalle,
    fecha: new Date().toISOString(),
    leido: false,
  });
  guardarActividadInventario(lista);
}

// ---------- Prueba gratuita (2 semanas desde el registro) ----------
// Solo aviso — José Luis decide manualmente cuándo revocar acceso a quien no
// pagó (mismo botón de activar/revocar que ya existe), no hay bloqueo
// automático. Ingrid y Jose Parejas quedan afuera del conteo: son clientes
// reales suyos, no agentes de la prueba pública, y sus cuentas ya tenían más
// de 2 semanas cuando se armó esto.
const DIAS_PRUEBA_GRATIS = 14;
const AGENTES_SIN_TRIAL = new Set(['af7749fc', '00753b8a']); // Ingrid Cuellar, Jose Parejas

function estadoTrial(agente) {
  if (AGENTES_SIN_TRIAL.has(agente.id)) return { aplica: false, diasRestantes: null, vencido: false };
  const diasTranscurridos = Math.floor((Date.now() - new Date(agente.creado).getTime()) / 86400000);
  const diasRestantes = DIAS_PRUEBA_GRATIS - diasTranscurridos;
  return { aplica: true, diasRestantes, vencido: diasRestantes <= 0 };
}

// ---------- Almacenamiento de alertas de match ----------
// Se generan cuando una propiedad nueva (cargada a mano, sincronizada desde
// GHL indirectamente vía requerimiento, o detectada en la sincronización de
// Mobiliario App) matchea un requerimiento guardado del agente.

function archivoAlertas(agenteId) {
  return path.join(DATA_DIR, `alertas-${agenteId || 'sin-agente'}.json`);
}

function leerAlertas(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoAlertas(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

function guardarAlerta(agenteId, datos) {
  const lista = leerAlertas(agenteId);
  const alerta = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    creado: new Date().toISOString(),
    leida: false,
    ...datos,
  };
  lista.unshift(alerta);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(archivoAlertas(agenteId), JSON.stringify(lista, null, 2));
  return alerta;
}

function marcarAlertaLeida(agenteId, id) {
  const lista = leerAlertas(agenteId);
  const idx = lista.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  lista[idx].leida = true;
  fs.writeFileSync(archivoAlertas(agenteId), JSON.stringify(lista, null, 2));
  return true;
}

// ---------- Registro de envíos directos a clientes ----------
// Cada vez que el barrido de matches manda propiedades directo al cliente
// (no al agente) queda una entrada acá — quién, qué se le mandó, cuándo, y
// si el envío salió bien. Es auditoría, no se usa para lógica de negocio.
function archivoEnviosClientes(agenteId) {
  return path.join(DATA_DIR, `envios-clientes-${agenteId || 'sin-agente'}.json`);
}

function leerEnviosClientes(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoEnviosClientes(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

function envioPorId(agenteId, id) {
  return leerEnviosClientes(agenteId).find((e) => e.id === id);
}

function registrarEnvioCliente(agenteId, datos) {
  const lista = leerEnviosClientes(agenteId);
  // ID con entropía real (16 bytes / 128 bits vía crypto, no Math.random) —
  // este id es la ÚNICA protección de /p/:agenteId/:id y /revisar/:agenteId/:id
  // (páginas públicas sin login, José Luis pidió blindarlas el 2026-08-05).
  // La de /revisar/ expone el contacto real del captador y puede
  // aprobar/rechazar en nombre del agente, así que necesita ser realmente
  // imposible de adivinar, no solo "poco probable".
  const registro = { id: crypto.randomBytes(16).toString('hex'), fecha: new Date().toISOString(), ...datos };
  lista.unshift(registro);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Tope de 2000 entradas por agente — auditoría reciente, no un log infinito.
  fs.writeFileSync(archivoEnviosClientes(agenteId), JSON.stringify(lista.slice(0, 2000), null, 2));
  return registro;
}

// ---------- Registro de captadores (agentes captadores de otras fuentes) ----------
// José Luis lo pidió el 2026-08-04: necesita saber quién capturó cada
// propiedad que le mandamos a un cliente, y su teléfono, para poder
// contactarlo él mismo y gestionar la propiedad — sin esto, no hay forma de
// ubicar al dueño real del aviso una vez que el link no se le manda al
// cliente. Deduplicado por captador (mismo teléfono/email/nombre+fuente):
// cada propiedad nueva que le encontramos se le agrega a su ficha existente
// en vez de crear un captador repetido por cada propiedad.
function archivoCaptadores(agenteId) {
  return path.join(DATA_DIR, `captadores-${agenteId || 'sin-agente'}.json`);
}

function leerCaptadores(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoCaptadores(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

function guardarCaptadores(agenteId, lista) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(archivoCaptadores(agenteId), JSON.stringify(lista, null, 2));
}

function claveCaptador(c) {
  return (c.captadorTelefono || c.captadorEmail || `${c.captadorNombre}|${c.fuente}` || '').toLowerCase().trim();
}

// Upsert puro en memoria (sin leer/escribir disco) — separado de
// registrarCaptador para poder registrar muchos items de una sola búsqueda
// con UNA sola lectura y UNA sola escritura del archivo (ver
// registrarCaptadores más abajo). `it` es un item normalizado de buscarTodo
// (título, precio, link, asesor, etc.); `lista` se muta in-place.
function upsertCaptadorEnLista(lista, it) {
  if (!it.asesor && !it.telefono && !it.whatsapp && !it.email) return null; // nada que registrar
  const datos = {
    captadorNombre: it.asesor || 'Sin nombre',
    captadorTelefono: it.telefono || it.whatsapp || '',
    captadorEmail: it.email || '',
    captadorOficina: it.oficina || '',
    fuente: it.fuente,
  };
  const clave = claveCaptador(datos);
  if (!clave) return null;
  let captador = lista.find((c) => claveCaptador(c) === clave);
  if (!captador) {
    captador = { ...datos, primeraVez: new Date().toISOString(), propiedades: [] };
    lista.unshift(captador);
  } else {
    // Se actualizan datos de contacto por si mejoraron (ej. antes solo nombre, ahora también teléfono).
    if (it.telefono || it.whatsapp) captador.captadorTelefono = it.telefono || it.whatsapp;
    if (it.email) captador.captadorEmail = it.email;
    if (it.oficina) captador.captadorOficina = it.oficina;
  }
  const yaTiene = captador.propiedades.some((p) => p.link === it.link);
  if (!yaTiene) {
    captador.propiedades.unshift({ titulo: it.titulo, precio: it.precio, zona: it.zona, link: it.link || '', vistoEl: new Date().toISOString() });
    captador.propiedades = captador.propiedades.slice(0, 100);
  }
  captador.ultimaVez = new Date().toISOString();
  return captador;
}

// Registra UN captador (lee y guarda el archivo completo) — usado donde solo
// hay unos pocos items a la vez (ej. las hasta 8 opciones de
// prepararRevisionCliente). Para registrar muchos de una sola búsqueda, usar
// registrarCaptadores en vez de llamar esto en loop (evita releer/reescribir
// el archivo completo por cada item, que con búsquedas de cientos/miles de
// avisos sería carísimo).
function registrarCaptador(agenteId, it) {
  const lista = leerCaptadores(agenteId);
  const captador = upsertCaptadorEnLista(lista, it);
  if (!captador) return null;
  guardarCaptadores(agenteId, lista.slice(0, 1000));
  return captador;
}

// Registra MUCHOS items de una sola búsqueda con una sola lectura/escritura.
// Usado por GET /api/buscar (cada búsqueda interactiva) y POST
// /api/reporte-zona (que puede traer miles de avisos de una zona entera).
function registrarCaptadores(agenteId, items) {
  if (!items.length) return;
  const lista = leerCaptadores(agenteId);
  for (const it of items) upsertCaptadorEnLista(lista, it);
  guardarCaptadores(agenteId, lista.slice(0, 1000));
}

// ---------- Reportes de zona (mercado completo, para presentar a clientes) ----------
// José Luis lo pidió el 2026-08-15, después de que le armamos a mano el
// análisis de terrenos en Urubó Golf para su clienta Mari Campos: quiere esa
// misma foto completa de "todo lo que se está vendiendo en una zona" (no solo
// lo que matchea un requerimiento puntual) generable con un botón desde
// cualquier búsqueda, para poder presentársela a futuros clientes con un link
// propio — no un ACM (que es estadística), sino el listado real. Guarda un
// snapshot (no una búsqueda en vivo cada vez que se abre el link) para que el
// link que le pasa al cliente no cambie de contenido de un día para el otro.
function archivoReportesZona(agenteId) {
  return path.join(DATA_DIR, `reportes-zona-${agenteId || 'sin-agente'}.json`);
}

function leerReportesZona(agenteId) {
  try {
    return JSON.parse(fs.readFileSync(archivoReportesZona(agenteId), 'utf8'));
  } catch {
    return [];
  }
}

function reporteZonaPorId(agenteId, id) {
  return leerReportesZona(agenteId).find((r) => r.id === id);
}

// Mismo criterio que registrarEnvioCliente: id con entropía real (16 bytes
// vía crypto), porque es la única protección de la página pública /reporte/.
function guardarReporteZona(agenteId, datos) {
  const lista = leerReportesZona(agenteId);
  const registro = { id: crypto.randomBytes(16).toString('hex'), creado: new Date().toISOString(), ...datos };
  lista.unshift(registro);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Tope de 300 reportes guardados por agente — esto es para presentar a
  // clientes puntuales, no un historial infinito.
  fs.writeFileSync(archivoReportesZona(agenteId), JSON.stringify(lista.slice(0, 300), null, 2));
  return registro;
}

// Recorre data/requerimientos-*.json de TODOS los agentes y genera una
// alerta por cada requerimiento (mismo tipo+operación) que matchee el item —
// se usa cuando aparece una propiedad genuinamente NUEVA (no solo
// modificada) en la sincronización de Mobiliario App, la única fuente con
// caché histórica hoy (C21/RE-MAX/BienInmuebles son búsquedas en vivo, sin
// forma de saber si un aviso es "nuevo" desde la última vez).
function matchearContraTodosLosAgentes(item, origen) {
  if (!item) return;
  let archivos;
  try {
    archivos = fs.readdirSync(DATA_DIR).filter((f) => /^requerimientos-.+\.json$/.test(f));
  } catch {
    return;
  }
  for (const archivo of archivos) {
    const agenteId = archivo.replace(/^requerimientos-/, '').replace(/\.json$/, '');
    let requerimientos;
    try {
      requerimientos = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivo), 'utf8'));
    } catch {
      continue;
    }
    for (const r of requerimientos) {
      if (r.tipo !== item.tipo || r.operacion !== item.operacion) continue;
      if (matcheaPropiedad({ ...item }, r)) {
        guardarAlerta(agenteId, {
          origen,
          propiedad: {
            titulo: item.titulo,
            precio: item.precio,
            zona: item.zona,
            tipo: item.tipo,
            operacion: item.operacion,
            link: item.link || '',
          },
          requerimiento: {
            id: r.id,
            cliente: r.cliente,
            telefono: r.telefono,
            zona: r.zona,
            precioMin: r.precioMin,
            precioMax: r.precioMax,
          },
        });
      }
    }
  }
}

// ---------- Utilidades de precio / zona ----------

// Acepta "65.000", "65,000" o "65000" y devuelve 65000 (entero).
function parsePrecio(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Busca en un texto libre (título+descripción de un aviso) una mención de
// precio con símbolo de moneda (US$/USD/Bs) que difiera bastante del precio
// estructurado que ya trae el portal — señal de que el agente que publicó
// el aviso escribió mal uno de los dos campos. Requiere símbolo de moneda
// explícito para no confundir m², año de construcción, teléfonos, etc. con
// un precio.
function detectarPrecioInconsistente(texto, precioEstructurado) {
  if (!precioEstructurado || !texto) return null;
  const candidatos = [...texto.matchAll(/(?:US\$|USD|Bs\.?)\s*([\d][\d.,]{3,})/gi)]
    .map((m) => Number(m[1].replace(/\./g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n > 500 && n < 50000000);
  return candidatos.find((n) => Math.abs(n - precioEstructurado) / precioEstructurado > 0.03) || null;
}

// Convierte el presupuesto a US$ (los portales cotizan en US$).
// moneda 'bob' → divide por el tipo de cambio (editable); 'usd' → tal cual.
function convertirPresupuesto(req) {
  const moneda = (req.moneda || 'usd').toLowerCase();
  const tc = Number(req.tc) > 0 ? Number(req.tc) : 6.96; // Bs por US$
  let min = parsePrecio(req.precioMin);
  let max = parsePrecio(req.precioMax);
  if (moneda === 'bob') {
    if (min) min = Math.round(min / tc);
    if (max) max = Math.round(max / tc);
  }
  return { precioMinUsd: min, precioMaxUsd: max, tc, moneda };
}

function normalizarZona(zona) {
  return zona
    .toLowerCase()
    .replace(/^\s*(zona|barrio)\s+/i, '')
    .split(/\s+/)
    .filter((w) => w !== 'a')
    .join(' ')
    .trim();
}

// "norte o este, Doble Vía a La Guardia" → ["norte", "este", "doble vía la guardia"]
function parseZonas(zonaTexto) {
  if (!zonaTexto || !zonaTexto.trim()) return [];
  return zonaTexto
    .split(/\s*(?:,|\/|;|\bo\b|\by\b)\s*/i)
    .map((s) => normalizarZona(s))
    .filter(Boolean);
}

function textoItem(i) {
  return `${i.titulo} ${i.zona} ${i.direccion} ${i.descripcion}`.toLowerCase();
}

// Saca tildes/diéresis (NFD + quitar marcas de acento) para que "Urubó" (como
// lo escribe RE/MAX) matchee "Urubo" (como lo escribe C21) y viceversa — sin
// esto, elegir una zona con tilde del selector podía dar 0 resultados de una
// fuente que la escribe sin tilde. Bug real encontrado 2026-07-19 (Urubó: 0
// resultados vs Urubo: 53).
function quitarAcentos(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Puntos cardinales: se matchean SOLO contra el campo de zona estructurado
// (evita que "este" pegue dentro de "oeste" o con el "este" demostrativo).
const CARDINALES = new Set(['norte', 'sur', 'este', 'oeste', 'central', 'centro', 'noroeste', 'noreste', 'sudoeste', 'sudeste']);

function zonaMatch(item, zona) {
  const zonaPlana = quitarAcentos(zona).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b' + zonaPlana + '\\b', 'i');
  const texto = CARDINALES.has(zona) ? item.zona : textoItem(item);
  return re.test(quitarAcentos(texto));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---------- Century 21 Bolivia (c21.com.bo, API json=true) ----------

// Slugs verificados 2026-07-23 contra el listado real que expone la propia
// API de C21 (`filtros` en la respuesta de `?json=true`) — antes "local" y
// "oficina" tenían slugs inventados (`tipo_local-comercial`, `tipo_oficina`)
// que daban 404 en silencio, dejando esas dos categorías con 0 resultados
// de C21 siempre, sin que se notara como error hasta que apareció un
// requerimiento real de oficina (bug encontrado 2026-07-23).
// Verificado contra la API en vivo el 2026-07-28: estos 17 slugs (todos en
// singular) filtran correctamente por tipoPropiedad real en cada caso.
// 'terreno-comercial' no tiene categoría propia en C21 — queda afuera del
// mapa a propósito (ver el guard en fetchC21 más abajo, que evita mandar la
// búsqueda sin filtro de tipo cuando no hay mapeo).
const C21_TIPO = {
  casa: 'tipo_casa-o-casa-en-condominio',
  departamento: 'tipo_departamento-o-penthouse',
  terreno: 'tipo_terreno',
  local: 'tipo_local',
  oficina: 'tipo_oficinas',
  quinta: 'tipo_quinta',
  edificio: 'tipo_edificio',
  deposito: 'tipo_deposito',
  tinglado: 'tipo_tinglado',
  rural: 'tipo_rural',
  rancho: 'tipo_rancho',
  agricolas: 'tipo_agricolas',
  ganaderas: 'tipo_ganaderas',
  cochera: 'tipo_cochera',
  hotel: 'tipo_hotel',
  colegio: 'tipo_colegio',
  proyecto: 'tipo_proyecto',
};
// C21 expone el total real de avisos en `totalHits` (string con puntos de
// miles, ej. "1.350") — se pagina dinámicamente hasta traerlos todos, en vez
// de un límite fijo. Antes se pedían solo 2 páginas (200 avisos) cuando
// categorías como "terreno en venta" tienen más de 1.300 reales — se estaba
// perdiendo hasta el 85% de los avisos en silencio (bug corregido 2026-07-19).
// Techo de seguridad para no pedir de más si algún día un total sale gigante.
const C21_POR_PAGINA = 100;
const C21_PAGINAS_MAX = 20; // 2.000 avisos — margen sobre el máximo real visto (~1.350)

function urlC21(req, pagina) {
  const tipo = C21_TIPO[req.tipo] ? C21_TIPO[req.tipo] + '/' : '';
  const op = req.operacion === 'alquiler' ? 'operacion_renta' : 'operacion_venta';
  const pag = pagina > 1 ? `/pagina_${pagina}` : '';
  return `https://c21.com.bo/v/resultados/${tipo}${op}/en-pais_bolivia/en-estado_santa-cruz${pag}?json=true`;
}

// Respaldo (ya no es la fuente principal — ver parseM2ConRespaldo más abajo)
// para cuando C21 no traiga m2TSort/m2CSort numérico. Parsea "." como
// separador de miles (ej. "3.723" = 3.723 m², no 3,723).
function parseM2Format(v) {
  const n = Number(String(v || '').replace(/\D/g, ''));
  return n > 0 ? n : null;
}

// m2TSort/m2CSort son la fuente correcta: C21 ya los entrega convertidos a
// m², resolviendo dos problemas de una vez que m2TFormat/m2CFormat (parseado
// a mano) no puede — separador de miles Y unidad de medida real (algunos
// terrenos grandes vienen en hectáreas, no m²; ej. un terreno de 29,4 ha
// tiene m2TFormat="29" pero m2TSort=294000, el valor correcto en m²).
// Verificado contra 1.571 avisos reales de las 5 categorías (terreno, casa,
// depto, oficina, local) el 2026-07-26: m2TSort/m2CSort siempre presentes y
// numéricos, ningún caso ausente. Por las dudas, si algún día faltan, hay
// un respaldo explícito (parseM2Format) y se registra en vez de caer a null
// en silencio.
function parseM2ConRespaldo(sort, formatStr, idAviso) {
  if (typeof sort === 'number' && Number.isFinite(sort) && sort > 0) return sort;
  const respaldo = parseM2Format(formatStr);
  console.error(
    `C21: aviso ${idAviso || '?'} sin m2Sort numérico válido (${JSON.stringify(sort)}) — ` +
    `usando respaldo parseM2Format(${JSON.stringify(formatStr)}) = ${respaldo}`
  );
  return respaldo;
}

function normalizarC21(r, operacion) {
  // enInternet=false = el propio C21 lo sacó de publicación (vendido, bajado,
  // etc.) — no debe aparecer en los resultados. Verificado 2026-07-19 con 400
  // avisos reales: el 100% de lo que trae este endpoint viene con
  // enInternet=true (es el mismo feed que usa la búsqueda pública del sitio),
  // pero se chequea igual por si el propio C21 alguna vez expone algo dado de baja.
  if (r.enInternet === false) return null;
  // Chequeo de respaldo (encontrado el 2026-08-07 al descubrir el bug real
  // de RE/MAX): el filtro de operación se pide por URL y hasta ahora se
  // confiaba ciegamente en que el portal lo respetara — acá C21 SÍ lo
  // respeta (verificado en vivo, "en venta"/"en renta" 100% consistentes),
  // pero este chequeo queda como red de seguridad para el futuro, no
  // porque haya un bug conocido hoy en C21 puntualmente.
  const operacionTxtEsperado = operacion === 'alquiler' ? 'en renta' : 'en venta';
  if (r.tipoOperacionTxt && r.tipoOperacionTxt !== operacionTxtEsperado) return null;
  const fotos = r.fotos && r.fotos.propiedadThumbnail;
  const usd = r.precios?.vista?.precio;
  let precio = usd ? Math.round(usd) : null;
  // Se descarta lo implausible (typos, ej. una casa en venta a "US$ 78").
  // Los alquileres normalmente son < US$1000/mes, así que ahí el umbral es
  // mucho más bajo — si no, se estaban perdiendo TODOS los alquileres reales.
  const umbralTypo = operacion === 'alquiler' ? 10 : 1000;
  if (precio != null && precio < umbralTypo) precio = null;
  return {
    fuente: 'Century 21',
    titulo: r.encabezado || '(sin título)',
    precio,
    dormitorios: r.recamaras > 0 ? r.recamaras : null,
    banos: r.banos > 0 ? r.banos : null,
    m2Terreno: parseM2ConRespaldo(r.m2TSort, r.m2TFormat, r.id),
    m2Construccion: parseM2ConRespaldo(r.m2CSort, r.m2CFormat, r.id),
    zona: [r.coloniaWeb || r.colonia, r.municipio, r.estado].filter(Boolean).join(', '),
    direccion: '',
    lat: Number(r.lat) || null,
    lon: Number(r.lon) || null,
    imagen: Array.isArray(fotos) && fotos.length ? fotos[0] : null,
    // Hasta 6 fotos para la galería de la página de presentación — C21 es la
    // única de las 3 fuentes que expone más de una foto por aviso.
    imagenes: Array.isArray(fotos) ? fotos.slice(0, 6) : [],
    link: 'https://c21.com.bo' + (r.urlCorrectaPropiedad || ''),
    descripcion: r.encabezado || '',
    oficina: r.nombreAfiliado || '',
    fecha: r.fechaAlta || null,
    // Contacto del asesor captador (C21 lo expone directo)
    asesor: r.asesorNombre || '',
    whatsapp: (r.whatsapp || '').replace(/[^\d]/g, ''),
    telefono: r.telefono || '',
    email: r.email || '',
  };
}

async function fetchC21(req) {
  // Si el tipo pedido no tiene mapeo en C21_TIPO, NO se manda la búsqueda —
  // urlC21 omitiría el segmento de tipo en silencio y devolvería resultados
  // de TODOS los tipos sin filtrar (bug real encontrado 2026-07-28 al
  // agregar 'terreno-comercial', que no tiene categoría propia acá).
  if (!C21_TIPO[req.tipo]) return [];
  // La primera página NO atrapa el error acá — si falla, buscarTodo debe
  // enterarse (para avisar "C21 no respondió" en vez de mostrar 0 en
  // silencio, como pasaba antes). Las páginas siguientes sí toleran fallos
  // individuales sin tirar toda la búsqueda.
  const primera = await fetchJson(urlC21(req, 1));
  if (!Array.isArray(primera.results)) throw new Error('Respuesta inesperada de Century 21');
  const items = primera.results.map((r) => normalizarC21(r, req.operacion)).filter(Boolean);

  // totalHits viene como string con puntos de miles ("1.350") — se limpia a número.
  const total = Number(String(primera.totalHits || '').replace(/\D/g, '')) || primera.results.length;
  const totalPaginas = Math.min(Math.ceil(total / C21_POR_PAGINA), C21_PAGINAS_MAX);

  if (totalPaginas > 1) {
    const paginas = [];
    for (let p = 2; p <= totalPaginas; p++) paginas.push(p);
    const datas = await Promise.all(paginas.map((p) => fetchJson(urlC21(req, p)).catch(() => null)));
    for (const d of datas) {
      if (d && Array.isArray(d.results)) items.push(...d.results.map((r) => normalizarC21(r, req.operacion)).filter(Boolean));
    }
  }
  return items;
}

// ---------- RE/MAX Bolivia (remax.bo/api/search) ----------

// IDs de subtype_property verificados contra la API en vivo el 2026-07-28
// (escaneadas 40 páginas reales de Santa Cruz). Corrige un bug preexistente:
// 'local' incluía el id 55 ("Galpon", no es local comercial — el id real es
// 8, "Local Comercial", que nunca estaba incluido) y 'oficina' no incluía el
// id 62 ("Oficina") — solo tenía el genérico 1 ("Comercial/Negocio").
const RMX_SUB = {
  casa: [161, 42, 228],
  departamento: [131, 174, 140],
  terreno: [101],
  local: [1, 8],
  oficina: [1, 62],
  quinta: [27, 229], // 229 = "Casa de Campo", mismo concepto que quinta
  'terreno-comercial': [110],
  edificio: [114, 128, 208],
  deposito: [55], // "Galpon"
};
const RMX_CITY_SC = 4; // Santa Cruz de la Sierra
// RE/MAX expone `total`/`last_page` (paginación estándar Laravel) — se
// pagina dinámicamente igual que C21. Antes se pedían solo 3 páginas (60
// avisos) cuando "casa" real ronda 700+ — mismo bug que C21, corregido junto.
// Subido de 40 a 80 el 2026-08-19: "casa en venta" ya venía pegado al techo
// viejo (682 de 800, 85%) — sin margen real, cualquier crecimiento normal del
// inventario se hubiera empezado a recortar en silencio (el corte es
// Math.min contra el last_page real de la API, así que subir esto no cuesta
// nada mientras el inventario real sea menor).
const RMX_PAGINAS_MAX = 80; // 20 avisos/página → techo de 1.600 avisos

// BUG REAL encontrado 2026-08-07 (reportado por José Luis: "busqué casa en
// venta y salieron casas en alquiler"): esta función pegaba siempre a
// /api/search (sin ningún filtro de operación) y confiaba en que
// subtype_property_ids alcanzara — pero /api/search sin más devuelve TODOS
// los transaction_type_id mezclados (venta=1, alquiler=2, anticrético=3).
// El filtro de operación de RE/MAX no es un query param, es un SEGMENTO de
// la URL (/api/search/venta o /api/search/alquiler) — confirmado inspeccionando
// las llamadas reales que hace remax.bo al usar sus propios botones "Quiero
// Comprar"/"Quiero Alquilar". Ninguna otra parte del pipeline (normalizarRemax,
// matcheaPropiedad) volvía a chequear la operación del aviso, así que esta
// mezcla pasaba directo al agente sin ningún filtro de respaldo.
const RMX_OPERACION_SEGMENTO = { venta: 'venta', alquiler: 'alquiler' };

function urlRemax(req, pagina, minUsd, maxUsd) {
  const p = new URLSearchParams();
  p.set('city_id', String(RMX_CITY_SC));
  (RMX_SUB[req.tipo] || []).forEach((id) => p.append('subtype_property_ids[]', String(id)));
  if (minUsd) p.set('min_price', String(minUsd));
  if (maxUsd) p.set('max_price', String(maxUsd));
  p.set('page', String(pagina));
  const segmento = RMX_OPERACION_SEGMENTO[req.operacion] || RMX_OPERACION_SEGMENTO.venta;
  return `https://remax.bo/api/search/${segmento}?` + p.toString();
}

function normalizarRemax(r) {
  // status_listing_id=2 ("Activa") es lo único que vimos en 60 avisos reales
  // verificados (2026-07-19) — se chequea igual por si aparece algo vendido/
  // reservado/inactivo (cualquier id que no sea el "Activa" confirmado).
  if (r.status_listing_id != null && r.status_listing_id !== 2) return null;
  const li = r.listing_information || {};
  const loc = r.location || {};
  const zona = loc.zone && loc.zone.name ? loc.zone.name : '';
  const tipo = li.subtype_property && li.subtype_property.name ? li.subtype_property.name : 'Propiedad';
  return {
    fuente: 'RE/MAX',
    titulo: `${tipo}${zona ? ' en ' + zona : ''}`,
    precio: r.price && r.price.price_in_dollars ? Math.round(r.price.price_in_dollars) : null,
    dormitorios: li.number_bedrooms > 0 ? li.number_bedrooms : null,
    banos: li.number_bathrooms > 0 ? li.number_bathrooms : null,
    m2Terreno: Math.round(Number(li.land_m2)) || null,
    m2Construccion: Math.round(Number(li.construction_area_m)) || null,
    zona: [zona, loc.city && loc.city.name].filter(Boolean).join(', '),
    direccion: loc.first_address || '',
    lat: Number(loc.latitude) || null,
    lon: Number(loc.longitude) || null,
    imagen: r.default_imagen && (r.default_imagen.url || r.default_imagen.link) || null,
    // RE/MAX solo expone una foto en este endpoint de búsqueda (el resto
    // está en la página individual del aviso, no vale la pena un pedido
    // extra por cada propiedad solo para más fotos).
    imagenes: r.default_imagen && (r.default_imagen.url || r.default_imagen.link) ? [r.default_imagen.url || r.default_imagen.link] : [],
    link: 'https://remax.bo/propiedad/' + (r.slug || ''),
    descripcion: '',
    fecha: r.date_of_listing || null,
    transaction_type_id: r.transaction_type_id,
    // RE/MAX expone nombre y oficina; el contacto va por la página del aviso
    asesor: r.agent?.user?.name_to_show || '',
    oficina: r.agent?.office?.name || '',
    whatsapp: '',
    telefono: '',
    email: '',
  };
}

async function fetchRemax(req, minUsd, maxUsd) {
  // Mismo motivo que el guard de fetchC21: sin esto, un tipo sin mapeo en
  // RMX_SUB mandaría la búsqueda sin ningún subtype_property_ids[], trayendo
  // resultados de TODOS los subtipos sin filtrar.
  if (!RMX_SUB[req.tipo]) return [];
  const primera = await fetchJson(urlRemax(req, 1, minUsd, maxUsd));
  if (!Array.isArray(primera.data)) throw new Error('Respuesta inesperada de RE/MAX');
  const items = primera.data.map(normalizarRemax).filter(Boolean);

  const totalPaginas = Math.min(Number(primera.last_page) || 1, RMX_PAGINAS_MAX);
  if (totalPaginas > 1) {
    const paginas = [];
    for (let p = 2; p <= totalPaginas; p++) paginas.push(p);
    const datas = await Promise.all(paginas.map((p) => fetchJson(urlRemax(req, p, minUsd, maxUsd)).catch(() => null)));
    for (const d of datas) {
      if (d && Array.isArray(d.data)) items.push(...d.data.map(normalizarRemax).filter(Boolean));
    }
  }
  // La API no filtra por operación de forma fiable → se filtra acá.
  const opId = req.operacion === 'alquiler' ? 2 : 1;
  const filtrados = items.filter((i) => i.transaction_type_id == null || i.transaction_type_id === opId);
  // Dedupe por link — bug real encontrado 2026-08-14: al paginar en paralelo
  // (página 1 primero, después 2..N juntas), si el orden de RE/MAX cambia
  // entre esos dos pedidos (ej. un aviso se actualiza y sube de posición),
  // el mismo aviso puede caer en dos páginas distintas y salir duplicado —
  // llegó a ser hasta 92 avisos repetidos en una sola búsqueda de "casa".
  const vistos = new Set();
  return filtrados.filter((i) => (vistos.has(i.link) ? false : (vistos.add(i.link), true)));
}

// ---------- BienInmuebles (bieninmuebles.com.bo/common/php/procesos.php) ----------
// Endpoint AJAX interno del sitio (mismo que usa su propio buscador). Sin
// login, sin API key — un POST público común y corriente.

// IDs verificados probando id_orig 1-12 contra la API en vivo el 2026-07-28.
// id 9 ("rural") no tiene nombre de categoría expuesto por la API — inferido
// del contenido real de sus avisos ("Propiedad 632Ha, Zona Pailon").
const BIEN_TIPO = { casa: 1, departamento: 2, terreno: 3, oficina: 4, local: 5, deposito: 6, edificio: 7, rural: 9 };
const BIEN_FILAS = 60;
// BienInmuebles no expone un total (a diferencia de C21/RE/MAX) — el único
// endpoint que lo daría (proceso=getPaginador) nos dejó bloqueados por su
// protección anti-bot (Imunify360) al probarlo el 2026-07-19, así que no se
// usa. En cambio, se pide página por página, UNA A LA VEZ (no en paralelo,
// para ser más suaves con su servidor tras ese bloqueo) hasta que una página
// vuelva con menos de BIEN_FILAS avisos — señal de que es la última.
const BIEN_PAGINAS_MAX = 20; // techo de seguridad (1.200 avisos)

async function fetchJsonPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function normalizarBienInmuebles(r, tc, tipo, operacion) {
  // Red de seguridad agregada el 2026-08-07 (mismo criterio que C21) tras
  // encontrar que RE/MAX mezclaba venta/alquiler en silencio — acá el
  // parámetro `modalidad` que ya se manda en el POST sí viene respetado
  // (verificado en vivo, modalidad=1/2 100% consistentes con lo pedido),
  // pero se chequea igual como respaldo ante un cambio futuro del portal.
  const modalidadEsperada = operacion === 'alquiler' ? '2' : '1';
  if (r.modalidad_cata != null && String(r.modalidad_cata) !== modalidadEsperada) return null;
  const enBs = String(r.moneda_cata) === '1';
  const crudo = Number(String(r.precio_cata || '').replace(/[^\d.]/g, ''));
  let precio = crudo ? Math.round(enBs ? crudo / tc : crudo) : null;
  const dormitorios = Number(r.habitacion_cata);
  const banos = Number(r.banio_cata);
  // BienInmuebles solo trae una medida (supterreno_cata) — igual que
  // Mobiliario App, en terrenos es superficie de lote y en el resto (casa,
  // depto, oficina, local) es área construida. Antes se guardaba siempre
  // como m2Terreno sin importar el tipo, lo que rompía los filtros de m²
  // construidos para oficinas/locales/deptos de esta fuente (encontrado
  // 2026-07-24 investigando por qué una búsqueda de oficina con m² mínimo
  // casi no traía resultados).
  const m2 = Number(r.supterreno_cata) || null;
  return {
    fuente: 'BienInmuebles',
    titulo: r.nomb_cata || '(sin título)',
    precio,
    dormitorios: dormitorios > 0 ? dormitorios : null,
    banos: banos > 0 ? banos : null,
    m2Terreno: TIPOS_TERRENO.has(tipo) ? m2 : null,
    m2Construccion: TIPOS_TERRENO.has(tipo) ? null : m2,
    zona: [r.nomb_barri, r.nomb_grup].filter(Boolean).join(', '),
    direccion: r.direccion_cata || '',
    lat: Number(r.latitud_cata) || null,
    lon: Number(r.longitud_cata) || null,
    imagen: r.nomb_img ? 'https://www.bieninmuebles.com.bo/admin/uploads/catalogo/thumbs/' + r.nomb_img : null,
    imagenes: r.nomb_img ? ['https://www.bieninmuebles.com.bo/admin/uploads/catalogo/thumbs/' + r.nomb_img] : [],
    link: 'https://www.bieninmuebles.com.bo/property.php?id=' + r.id_cata,
    descripcion: r.nomb_cata || '',
    fecha: null, // el catálogo no expone fecha de publicación
    oficina: '',
    asesor: r.amigo_clie || '',
    whatsapp: '',
    telefono: '',
    email: '',
  };
}

async function fetchBienInmueblesPagina(req, pagina, modalidad) {
  return fetchJsonPost('https://www.bieninmuebles.com.bo/common/php/procesos.php', {
    search: '',
    id_fami: '1', // 1 = Santa Cruz (único departamento que trabajamos)
    id_orig: String(BIEN_TIPO[req.tipo] || 0),
    id_habi: '',
    id_bano: '',
    id_gara: '',
    id_carac: '',
    minprecio: '0',
    maxprecio: '0',
    page: String(pagina),
    filas: String(BIEN_FILAS),
    modalidad,
    proceso: 'getCatalogo',
  }).catch(() => null);
}

async function fetchBienInmuebles(req, tc) {
  // Mismo motivo que los guards de fetchC21/fetchRemax: id_orig=0 (lo que
  // resultaría de un tipo sin mapeo) devuelve resultados sin filtrar, no
  // vacío — confirmado contra la API en vivo.
  if (!BIEN_TIPO[req.tipo]) return [];
  const modalidad = req.operacion === 'alquiler' ? '2' : '1';
  const items = [];
  for (let p = 1; p <= BIEN_PAGINAS_MAX; p++) {
    const d = await fetchBienInmueblesPagina(req, p, modalidad);
    // Bug real encontrado 2026-08-18 (José Luis reportó "hay un sitio web
    // caído" — era BienInmuebles marcándose como no disponible en TODA
    // búsqueda de oficinas en venta): cuando una categoría no tiene ningún
    // aviso, su API no devuelve un array vacío, devuelve el booleano `false`
    // tal cual — confirmado pegándole en vivo con id_orig=4 (oficina)
    // modalidad=1 (venta). Antes esto se trataba igual que una respuesta
    // rota (bloqueo anti-bot, error del servidor) y tiraba la fuente entera
    // como "no disponible", cuando en realidad es una respuesta válida de
    // "cero resultados".
    if (d === false) break;
    if (!Array.isArray(d)) {
      // Esto sí sigue siendo una falla real (ej. el bloqueo anti-bot de
      // Imunify360 del 2026-07-19, o un error de servidor) — hay que
      // avisarlo, no devolver una lista vacía como si no hubiera avisos.
      if (p === 1) throw new Error((d && d.message) || 'Respuesta inesperada de BienInmuebles');
      break; // páginas siguientes: si fallan, nos quedamos con lo ya traído
    }
    items.push(...d.map((r) => normalizarBienInmuebles(r, tc, req.tipo, req.operacion)));
    if (d.length < BIEN_FILAS) break; // página incompleta = era la última
  }
  return items;
}

// ---------- Mobiliario App (mobiliario.app) ----------
// A diferencia de C21/RE/MAX/BienInmuebles, este portal NO tiene un endpoint
// de búsqueda masiva — su robots.txt bloquea /api explícitamente (verificado
// 2026-07-17 y de nuevo 2026-07-22, sigue igual). Pero SÍ permite leer sus
// páginas de propiedades individuales (`Allow: /`, solo bloquea /api, /agent,
// /me, /auth, /sign-in, /sign-up, /welcome, /onboarding) y cada una trae un
// bloque de datos estructurados estándar (schema.org JSON-LD, el mismo
// formato que usa Google para indexar) con precio, dormitorios, baños, m²,
// coordenadas — no un scraping de HTML fragil, es un formato público pensado
// para lectura automática. Su sitemap.xml (también público) lista TODAS las
// propiedades (~7.900 al 2026-07-22), pero como no hay búsqueda masiva, la
// única forma de tener esto disponible es sincronizar en segundo plano
// (una página a la vez, con pausas) y guardar en caché local — las búsquedas
// leen de esa caché, no le pegan a mobiliario.app en cada búsqueda del agente.

const MOBILIARIO_CACHE_FILE = path.join(DATA_DIR, 'cache-mobiliario.json');
const MOBILIARIO_LOTE = 4; // pedidos en paralelo por tanda
const MOBILIARIO_PAUSA_MS = 400; // pausa entre tandas — ritmo de crawler respetuoso, no ráfaga
const MOBILIARIO_MAX_FALLOS_SEGUIDOS = 8; // si falla muchas veces seguidas, para (probable bloqueo)
// Antes en 20h y solo se chequeaba al arrancar el servidor — si quedaba
// prendido varios días, nunca se volvía a revisar (bug corregido 2026-07-24,
// ver chequearResyncMobiliario). Bajado a 6h: después de la primera
// sincronización completa, las siguientes son "baratas" (solo se re-piden
// los avisos nuevos/modificados, comparando fechas del sitemap — la mayoría
// de los ~7.900 no cambiaron), así que revisar 4 veces al día es razonable
// y mantiene lo nuevo de otros portales visible el mismo día que se publica.
const MOBILIARIO_RESYNC_HORAS = 6;

function leerCacheMobiliario() {
  try {
    return JSON.parse(fs.readFileSync(MOBILIARIO_CACHE_FILE, 'utf8'));
  } catch {
    return { sincronizadoEn: null, enProgreso: false, ultimoError: null, listados: {} };
  }
}

function guardarCacheMobiliario(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MOBILIARIO_CACHE_FILE, JSON.stringify(cache));
}

// Extrae tipo/operación del breadcrumb ("Casas en venta en Santa Cruz…") en
// vez de confiar solo en @type (Place se usa tanto para terrenos como para
// otras cosas genéricas) — el texto del breadcrumb es más confiable.
// quinta/edificio/galpón agregados en 2026-07-28 de forma defensiva — no se
// confirmó que existan avisos de estas categorías en Mobiliario App (una
// muestra de 60 avisos reales solo trajo casa/depto/terreno/local/oficina),
// pero si aparecen en el futuro, quedan bien categorizados sin más cambios.
function categoriaDesdeBreadcrumb(breadcrumbJson) {
  const cat = breadcrumbJson?.itemListElement?.[1]?.name || '';
  const operacion = /alquiler/i.test(cat) ? 'alquiler' : 'venta';
  let tipo = null;
  if (/casas?/i.test(cat)) tipo = 'casa';
  else if (/departamentos?/i.test(cat)) tipo = 'departamento';
  else if (/terrenos?/i.test(cat)) tipo = 'terreno';
  else if (/locales?/i.test(cat)) tipo = 'local';
  else if (/oficinas?/i.test(cat)) tipo = 'oficina';
  else if (/quintas?/i.test(cat)) tipo = 'quinta';
  else if (/edificios?/i.test(cat)) tipo = 'edificio';
  else if (/galp(o|ó)n(es)?/i.test(cat)) tipo = 'deposito';
  return { operacion, tipo, categoriaTexto: cat };
}

function normalizarMobiliario(entidad, breadcrumbJson, url) {
  const { operacion, tipo, categoriaTexto } = categoriaDesdeBreadcrumb(breadcrumbJson);
  if (!tipo) return null; // categoría no reconocida (ej. otro tipo de propiedad) — se descarta
  // Oficinas y locales (@type "Place") no traen floorSize en el schema.org de
  // Mobiliario App — solo casa/depto/terreno (House/Apartment) lo declaran.
  // El m² sí está en texto plano dentro de la descripción autogenerada
  // ("Oficina en Santa Cruz de la Sierra, 188 m², $1.790...") — se rescata de
  // ahí como respaldo. Encontrado 2026-07-24: sin esto, TODAS las oficinas y
  // locales de esta fuente quedaban con m2Construccion null y desaparecían
  // de cualquier búsqueda con filtro de m² mínimo, aunque el dato exista.
  const m2Descripcion = entidad.description ? entidad.description.match(/,\s*([\d.,]+)\s*m²/i) : null;
  const m2 = entidad.floorSize?.value
    ? Math.round(Number(entidad.floorSize.value))
    : m2Descripcion
      ? Math.round(Number(m2Descripcion[1].replace(/\./g, '').replace(',', '.')))
      : null;
  // El schema.org de cada aviso declara su propia moneda (offers.priceCurrency)
  // — la mayoría son USD, pero varios están en Bs (bug real encontrado
  // 2026-07-23: una casa a "Bs 10.440.000" se estaba leyendo como si fueran
  // 10.44 millones de DÓLARES, inflando el precio ~7x). Como esta fuente se
  // sincroniza en segundo plano (no en el momento de cada búsqueda), se
  // guarda el precio crudo + moneda tal cual, y la conversión a US$ se hace
  // recién en `fetchMobiliario` con el tipo de cambio de ese momento — igual
  // que BienInmuebles.
  const monedaCruda = String(entidad.offers?.priceCurrency || 'USD').toUpperCase() === 'BOB' ? 'bob' : 'usd';
  return {
    fuente: 'Mobiliario App',
    operacion,
    tipo,
    titulo: entidad.name || '(sin título)',
    precioCrudo: entidad.offers?.price ? Math.round(Number(entidad.offers.price)) : null,
    monedaCrudo: monedaCruda,
    dormitorios: entidad.numberOfBedroomsTotal > 0 ? entidad.numberOfBedroomsTotal : null,
    banos: entidad.numberOfBathroomsTotal > 0 ? entidad.numberOfBathroomsTotal : null,
    // El schema solo trae una medida (floorSize) — en terrenos es la
    // superficie del lote; en casa/depto se asume área construida.
    m2Terreno: tipo === 'terreno' ? m2 : null,
    m2Construccion: tipo !== 'terreno' ? m2 : null,
    zona: categoriaTexto.replace(/^(Casas|Departamentos|Terrenos|Locales|Oficinas)\s+en\s+(venta|alquiler)\s+en\s+/i, ''),
    direccion: '',
    lat: entidad.geo?.latitude ?? null,
    lon: entidad.geo?.longitude ?? null,
    imagen: Array.isArray(entidad.image) && entidad.image.length ? entidad.image[0] : null,
    imagenes: Array.isArray(entidad.image) ? entidad.image.slice(0, 6) : [],
    link: url,
    descripcion: entidad.description || '',
    oficina: '',
    fecha: null, // no viene fecha de publicación en el schema
    asesor: '',
    whatsapp: '',
    telefono: '',
    email: '',
    ciudad: entidad.address?.addressLocality || '',
  };
}

async function fetchTexto(url) {
  // Timeout más largo que FETCH_TIMEOUT_MS porque acá también se descarga
  // el sitemap.xml completo de Mobiliario App (10.000+ propiedades) — una
  // descarga legítimamente más pesada que un pedido de búsqueda normal.
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function obtenerListingsSitemap() {
  const xml = await fetchTexto('https://mobiliario.app/sitemap.xml');
  const items = [];
  const re = /<url>\s*<loc>https:\/\/mobiliario\.app\/listings\/([a-f0-9-]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g;
  let m;
  while ((m = re.exec(xml))) items.push({ id: m[1], lastmod: m[2] });
  return items;
}

async function sincronizarUnaPropiedad(id) {
  const url = 'https://mobiliario.app/listings/' + id;
  const html = await fetchTexto(url);
  const bloques = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => {
      try { return JSON.parse(m[1]); } catch { return null; }
    })
    .filter(Boolean);
  const entidad = bloques.find((b) => ['House', 'Apartment', 'Place', 'Product'].includes(b['@type']));
  const breadcrumb = bloques.find((b) => b['@type'] === 'BreadcrumbList');
  if (!entidad || !breadcrumb) return null;
  // Solo Santa Cruz — el portal también cubre otras ciudades de Bolivia y
  // esta app está scopeada a Santa Cruz (mismo criterio que las otras 3 fuentes).
  if (!/santa cruz/i.test(entidad.address?.addressLocality || '')) return null;
  return normalizarMobiliario(entidad, breadcrumb, url);
}

let sincronizandoMobiliario = false;

// Sincroniza en segundo plano: recorre el sitemap completo, pero solo trae
// de nuevo lo nuevo o modificado desde la última vez (compara `lastmod`).
// Guarda progreso cada tanda, así un reinicio del servidor no pierde lo ya
// avanzado — solo retoma lo que falte. Si detecta demasiados fallos
// seguidos (probable bloqueo del portal), para en vez de insistir a ciegas.
async function sincronizarMobiliario() {
  if (sincronizandoMobiliario) return;
  sincronizandoMobiliario = true;
  const cache = leerCacheMobiliario();
  cache.enProgreso = true;
  cache.ultimoError = null;
  try {
    const sitemap = await obtenerListingsSitemap();
    const porId = { ...cache.listados };

    // Bug real encontrado 2026-08-24 (José Luis: "aparece el link roto" al
    // abrir un aviso desde los resultados — la propiedad ya no existía en
    // mobiliario.app, daba su propio "Error 404"): esta poda ANTES vivía
    // recién después del loop de "pendientes" de más abajo — si el servidor
    // se reiniciaba a mitad de esa sincronización (pasa seguido en
    // desarrollo, y puede pasar en producción con un redeploy), la poda
    // nunca llegaba a correr y los avisos dados de baja se quedaban
    // cacheados para siempre. El sitemap ya es la lista completa y vigente
    // apenas se pide, así que la poda puede (y debe) hacerse acá, antes de
    // arrancar el loop lento — así sobrevive aunque el proceso se corte
    // después.
    const idsVigentes = new Set(sitemap.map((s) => s.id));
    for (const id of Object.keys(porId)) {
      if (!idsVigentes.has(id)) delete porId[id];
    }
    cache.listados = porId;
    guardarCacheMobiliario(cache);

    // Además de lo nuevo/modificado, re-procesa lo que quedó en formato
    // viejo o incompleto — así una sola sincronización arregla sola los
    // datos ya cacheados, sin tener que borrar nada a mano:
    //  - precioCrudo/monedaCrudo por separado (bug de moneda, 2026-07-23)
    //  - m² de oficinas/locales rescatado de la descripción (2026-07-24)
    const pendientes = sitemap.filter((s) => {
      const cacheado = porId[s.id];
      if (!cacheado || cacheado.lastmod !== s.lastmod) return true;
      if (!cacheado.item) return false; // descartado a propósito (otra ciudad/categoría) — no reintentar
      if (cacheado.item.precioCrudo === undefined) return true;
      if (['oficina', 'local'].includes(cacheado.item.tipo) && cacheado.item.m2Construccion == null) return true;
      return false;
    });

    let fallosSeguidos = 0;
    for (let i = 0; i < pendientes.length; i += MOBILIARIO_LOTE) {
      const tanda = pendientes.slice(i, i + MOBILIARIO_LOTE);
      const resultados = await Promise.all(
        tanda.map(async (s) => {
          try {
            const item = await sincronizarUnaPropiedad(s.id);
            fallosSeguidos = 0;
            return { id: s.id, lastmod: s.lastmod, item };
          } catch (e) {
            fallosSeguidos++;
            return { id: s.id, error: e.message };
          }
        })
      );
      for (const r of resultados) {
        if (r.item) {
          // "Nueva" = no existía en la caché ANTES de arrancar esta
          // sincronización (no solo modificada) — dispara el matching contra
          // requerimientos guardados. cache.listados y porId apuntan al mismo
          // objeto después de la primera tanda, pero cada id se procesa una
          // sola vez por corrida, así que el chequeo sigue siendo correcto.
          const esNueva = !cache.listados[r.id];
          porId[r.id] = { lastmod: r.lastmod, item: r.item };
          if (esNueva) {
            const precioUsd =
              r.item.precioCrudo == null
                ? null
                : r.item.monedaCrudo === 'bob'
                  ? Math.round(r.item.precioCrudo / 6.96)
                  : r.item.precioCrudo;
            matchearContraTodosLosAgentes({ ...r.item, precio: precioUsd }, 'mobiliario');
          }
        } else if (r.item === null) porId[r.id] = { lastmod: r.lastmod, item: null }; // descartado (otra ciudad/categoría) — no reintentar
      }
      cache.listados = porId;
      cache.progreso = { procesados: Math.min(i + MOBILIARIO_LOTE, pendientes.length), total: pendientes.length };
      guardarCacheMobiliario(cache);

      if (fallosSeguidos >= MOBILIARIO_MAX_FALLOS_SEGUIDOS) {
        cache.ultimoError = `Se detuvo tras ${fallosSeguidos} fallos seguidos (posible bloqueo de mobiliario.app) — quedó con ${Object.keys(porId).length} de ${sitemap.length} propiedades.`;
        break;
      }
      await new Promise((r) => setTimeout(r, MOBILIARIO_PAUSA_MS));
    }

    // La poda de avisos dados de baja ya corrió arriba (antes del loop) —
    // acá solo queda guardar el resultado final del loop.
    cache.listados = porId;
    cache.sincronizadoEn = new Date().toISOString();
  } catch (e) {
    cache.ultimoError = 'No se pudo sincronizar: ' + e.message;
  } finally {
    cache.enProgreso = false;
    guardarCacheMobiliario(cache);
    sincronizandoMobiliario = false;
  }
}

// ---------- Sincronización de requerimientos desde GHL ----------
// Trae los leads que el bot de WhatsApp de cada cliente marcó con el custom
// field "Requerimiento" (cuando no encuentra match) y los suma al mismo
// almacén de requerimientos que ya usa la app — así quedan unificados con
// los que un agente carga a mano desde el formulario. Mismo patrón que la
// sincronización de Mobiliario App (flag + guardado de estado + setInterval).

// ---------- Meta Ads (opcional) ----------
// Cada agente conecta SU PROPIA cuenta publicitaria (OAuth) — José Luis solo
// crea la app de Meta for Developers una vez (META_APP_ID/META_APP_SECRET en
// el servidor); sin esas dos variables, todo lo de acá abajo queda
// silenciosamente desactivado, mismo criterio que GOOGLE_API_KEY/GEMINI_API_KEY.
function metaConfigurado() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}
function metaRedirectUri() {
  return process.env.META_REDIRECT_URI || 'https://buscador-inmuebles-production.up.railway.app/api/meta/callback';
}

const GHL_SYNC_ESTADO_FILE = path.join(DATA_DIR, 'ghl-sync-estado.json');
// Más frecuente que Mobiliario (6h): un lead nuevo importa más que una
// propiedad nueva, y esta sincronización es barata (pocos contactos por
// cliente comparado con los miles de avisos de Mobiliario App).
const GHL_RESYNC_HORAS = 1;

// Fuente principal: el `ghlConfig` guardado en cada agente (data/agentes.json)
// — José Luis lo carga una vez desde el panel admin (ver
// /api/admin/agentes/:id/ghl) cuando da de alta un cliente nuevo, cada uno
// queda con su propia conexión, aislada de las demás igual que sus
// requerimientos. GHL_LOCATIONS (variable de entorno, JSON array con la
// misma forma) sigue funcionando como fuente extra/de respaldo para no
// romper nada de lo ya probado — si un agenteId aparece en los dos lados, el
// de agentes.json gana.
function leerLocationsGHL() {
  const deAgentes = leerAgentes()
    .filter((a) => a.ghlConfig && a.ghlConfig.locationId && a.ghlConfig.token && a.ghlConfig.requerimientoFieldId)
    .map((a) => ({ agenteId: a.id, ...a.ghlConfig }));

  let deEnv = [];
  try {
    const parsed = JSON.parse(process.env.GHL_LOCATIONS || '[]');
    if (Array.isArray(parsed)) deEnv = parsed;
  } catch (e) {
    console.error('GHL_LOCATIONS mal formado (debe ser un JSON array):', e.message);
  }

  const porAgenteId = new Map(deEnv.map((l) => [l.agenteId, l]));
  for (const l of deAgentes) porAgenteId.set(l.agenteId, l); // agentes.json tiene prioridad
  return [...porAgenteId.values()];
}

function leerEstadoGHL() {
  try {
    return JSON.parse(fs.readFileSync(GHL_SYNC_ESTADO_FILE, 'utf8'));
  } catch {
    return { sincronizadoEn: null, enProgreso: false, ultimoError: null };
  }
}

function guardarEstadoGHL(estado) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GHL_SYNC_ESTADO_FILE, JSON.stringify(estado));
}

// Clasifica texto libre a uno de los TIPOS reales que maneja la app.
// Antes solo reconocía 5 tipos (casa/departamento/terreno/oficina/local) —
// bug real encontrado 2026-08-13: leads que pedían "monoambiente",
// "depósito", "quinta", etc. (o cuyo texto no tenía la palabra exacta
// esperada) no matcheaban ninguna, y quedaban sin campos.tipo.
function detectarTipoDesdeTexto(t) {
  t = (t || '').toLowerCase();
  if (/terreno\s*comercial/.test(t)) return 'terreno-comercial';
  if (/dep[oó]sito|galp[oó]n/.test(t)) return 'deposito';
  // mono.{0,3}ambiente tolera variantes/typos reales vistos en producción
  // (2026-08-13: un lead lo escribió "monohambiente").
  if (/mono.{0,3}ambiente|estudio|studio/.test(t)) return 'departamento';
  if (/depart|depto/.test(t)) return 'departamento';
  if (/terreno|lote|solar/.test(t)) return 'terreno';
  if (/oficina/.test(t)) return 'oficina';
  if (/\blocal\b/.test(t)) return 'local';
  if (/quinta/.test(t)) return 'quinta';
  if (/edificio/.test(t)) return 'edificio';
  if (/tinglado/.test(t)) return 'tinglado';
  if (/\brural\b/.test(t)) return 'rural';
  if (/rancho/.test(t)) return 'rancho';
  if (/agr[ií]cola/.test(t)) return 'agricolas';
  if (/ganader/.test(t)) return 'ganaderas';
  if (/cochera|garaje|garage/.test(t)) return 'cochera';
  if (/\bhotel\b/.test(t)) return 'hotel';
  if (/colegio|escuela/.test(t)) return 'colegio';
  if (/proyecto/.test(t)) return 'proyecto';
  if (/\bcasa\b/.test(t)) return 'casa';
  return null;
}

// Parsea el texto libre que guarda el bot ("Tipo: X | Zona: Y | Presupuesto: Z")
// a los campos del schema de requerimiento. Best-effort: si el formato no
// matchea (el bot no siempre lo escribe igual), el texto completo queda en
// "notas" y el resto vacío — no se descarta el lead por un formato distinto.
function parsearRequerimientoLibre(texto) {
  const campos = { notas: texto || '' };
  if (!texto) return campos;
  const tipoM = texto.match(/tipo:\s*([^|]+)/i);
  const zonaM = texto.match(/zona:\s*([^|]+)/i);
  const presM = texto.match(/presupuesto:\s*([^|]+)/i);
  if (tipoM) campos.tipo = detectarTipoDesdeTexto(tipoM[1]) || undefined;
  // Fallback: si no hay etiqueta "Tipo:" (el bot a veces guarda texto suelto,
  // ej. "Busca departamento hasta $70,000") o la etiqueta no matcheó ningún
  // tipo conocido, se busca la misma señal en todo el texto antes de darlo
  // por perdido — mejor que quede el requerimiento incompleto (se salta en
  // el barrido) a que quede mal etiquetado en silencio.
  if (!campos.tipo) campos.tipo = detectarTipoDesdeTexto(texto) || undefined;
  if (zonaM) campos.zona = zonaM[1].trim();
  if (presM) {
    const textoPresupuesto = presM[1];
    const numeros = textoPresupuesto.match(/[\d.,]+/g);
    if (numeros) {
      let valor = Number(numeros[numeros.length - 1].replace(/[.,]/g, ''));
      // "450 mil" / "370-450 mil" → el número capturado (450) se queda corto
      // por 1000x si no se detecta el "mil" — bug real encontrado revisando
      // el de moneda: un presupuesto de 450.000 se buscaba como 450.
      if (/\bmil\b/i.test(textoPresupuesto)) valor *= 1000;
      campos.precioMax = String(valor);
    }
    // Antes esto se descartaba (el regex de arriba solo agarra dígitos) y
    // TODO quedaba asumido en USD sin importar qué moneda haya dicho el
    // lead — bug real reportado por José Luis: un presupuesto en Bolivianos
    // se buscaba como si fuera en dólares (7x de diferencia real). Ahora se
    // respeta la moneda si el texto la menciona explícitamente.
    if (/\b(bs\.?|bob|bolivianos?)\b/i.test(textoPresupuesto)) campos.moneda = 'bob';
    else if (/\b(usd|us\$|u\$s|d[oó]lares?)\b/i.test(textoPresupuesto)) campos.moneda = 'usd';
  }
  return campos;
}

async function fetchContactosGHL(location, cursor) {
  const body = { locationId: location.locationId, pageLimit: 100 };
  if (cursor) body.searchAfter = cursor;
  const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + location.token,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// Busca/crea el contacto en GHL que representa el destino de las
// notificaciones (el propio agente) — mismo patrón de upsert que ya usa el
// resto del proyecto para no duplicar contactos. IMPORTANTE: si el teléfono
// ya corresponde a un contacto existente (ej. el número real de Ingrid, ya
// usado en otras conversaciones), NO se le pisa el nombre — un upsert previo
// llegó a renombrar su contacto real a "Notificaciones..." por mandar `name`
// sin querer. Acá se manda sin `name` a propósito.
async function upsertContactoNotificacionesGHL(location, { telefono, correo }) {
  const body = { locationId: location.locationId };
  if (telefono) body.phone = telefono;
  if (correo) body.email = correo;
  const res = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + location.token,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' al buscar/crear el contacto de notificaciones');
  const data = await res.json();
  const contactId = data.contact && data.contact.id;
  if (!contactId) throw new Error('GHL no devolvió un contactId al hacer upsert');
  return contactId;
}

// OJO — limitación real de la plataforma, no un bug: WhatsApp Business
// rechaza cualquier mensaje de texto libre a un contacto que no le escribió
// a este número en las últimas 24h ("customer service window"). El agente
// (Ingrid, Jose Parejas) nunca le escribe a su propio bot, así que este
// envío casi siempre va a fallar salvo que exista una plantilla de Meta
// aprobada — por eso el correo (enviarEmailGHL) es el canal principal para
// este aviso, no el WhatsApp.
async function enviarWhatsAppGHL(location, contactId, mensaje) {
  const res = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + location.token,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'WhatsApp', contactId, message: mensaje }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' al mandar el WhatsApp de notificación');
  return res.json();
}

async function enviarEmailGHL(location, contactId, correo, asunto, mensaje, esHtml) {
  const res = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + location.token,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'Email',
      contactId,
      emailTo: correo,
      subject: asunto,
      html: esHtml ? mensaje : mensaje.replace(/\n/g, '<br>'),
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' al mandar el email de notificación');
  return res.json();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Manda las propiedades directo al CLIENTE dueño del requerimiento (no al
// agente) — José Luis pidió esto explícitamente el 2026-08-04, con una
// condición clara: la propiedad se presenta con su fuente real (C21,
// RE/MAX, etc.) pero SIN el link directo al aviso del portal (eso expone
// el teléfono/perfil del captador original — un cliente sin escrúpulos
// podría saltarse a Ingrid). En vez del link crudo, se genera una página de
// presentación propia (ver paginaPresentacionCliente / ruta GET /p/:id) con
// la marca y el contacto de Ingrid — mismo criterio que ya usan los
// captadores de esta plaza con sus propios PDF sin marca ajena. El contacto
// real del captador (para que Ingrid pueda ubicarlo y coordinar) SÍ queda
// guardado en el registro interno (registrarEnvioCliente), invisible para
// el cliente.
// Ya NO manda nada al cliente directo — José Luis lo pidió el 2026-08-05:
// "la IA puede fallar", así que arma la propuesta y la deja en estado
// `pendiente` para que el agente (Ingrid) la revise, saque lo que no sirva,
// y recién ahí la apruebe (ver /revisar/:agenteId/:id y aprobarEnvioCliente
// más abajo). El link de revisión se manda en el digest del barrido, no acá.
async function prepararRevisionCliente(loc, agente, r, nuevos) {
  const TOPE_OPCIONES = 8;
  const top = nuevos.slice(0, TOPE_OPCIONES);

  let contactId = r.contactId || null;
  if (!contactId && r.telefono) {
    contactId = await upsertContactoNotificacionesGHL(loc, { telefono: r.telefono });
  }
  if (!contactId) throw new Error('El requerimiento no tiene teléfono ni contactId — no hay a quién mandarle nada.');

  const registro = registrarEnvioCliente(agente.id, {
    agenteId: agente.id,
    requerimientoId: r.id,
    cliente: r.cliente,
    telefono: r.telefono,
    contactId,
    zona: r.zona,
    tipo: r.tipo,
    estado: 'pendiente',
    cantidadTotal: nuevos.length,
    propiedades: top.map((it) => ({
      titulo: it.titulo,
      precio: it.precio,
      zona: it.zona,
      dormitorios: it.dormitorios ?? null,
      banos: it.banos ?? null,
      m2Terreno: it.m2Terreno ?? null,
      m2Construccion: it.m2Construccion ?? null,
      descripcion: it.descripcion || '',
      imagen: it.imagen || '',
      imagenes: Array.isArray(it.imagenes) && it.imagenes.length ? it.imagenes : it.imagen ? [it.imagen] : [],
      // Visible solo para el agente en su propio panel/página de revisión — nunca en la página pública del cliente.
      fuente: it.fuente,
      link: it.link || '',
      captadorNombre: it.asesor || '',
      captadorTelefono: it.telefono || it.whatsapp || '',
      captadorEmail: it.email || '',
      captadorOficina: it.oficina || '',
    })),
  });

  // Registro deduplicado por captador — separado del envío de arriba (que es
  // por cliente/fecha) para que José Luis pueda ver de un vistazo TODAS las
  // propiedades de un mismo captador, no una por envío. Se guarda ya en este
  // paso (no hace falta esperar la aprobación) porque el dato del captador
  // es útil de todas formas, se apruebe o no ese envío puntual.
  for (const it of top) registrarCaptador(agente.id, it);

  return registro;
}

// El agente aprobó (o edite: sacó algunas propiedades) desde la página de
// revisión — recién acá se arma y manda el mensaje real al cliente.
async function aprobarEnvioCliente(loc, agente, registro, indicesExcluidos) {
  const excluidos = new Set((indicesExcluidos || []).map(Number));
  const propiedadesFinales = registro.propiedades.filter((_, idx) => !excluidos.has(idx));
  if (!propiedadesFinales.length) throw new Error('No queda ninguna propiedad seleccionada para mandar.');

  const nombreAgente = (agente && agente.nombre) || 'tu agente inmobiliario';
  const contactoAgente = (agente && agente.telefonoContacto) || '';
  const lista = leerEnviosClientes(agente.id);
  const idx = lista.findIndex((e) => e.id === registro.id);
  if (idx !== -1) {
    lista[idx].propiedades = propiedadesFinales;
    lista[idx].estado = 'aprobado';
    lista[idx].aprobadoEl = new Date().toISOString();
    fs.writeFileSync(archivoEnviosClientes(agente.id), JSON.stringify(lista, null, 2));
  }

  const linkPresentacion = `${BASE_URL_APP}/p/${agente.id}/${registro.id}`;
  const cantidad = propiedadesFinales.length;
  const mensaje =
    `Hola ${registro.cliente}! 👋 Soy ${nombreAgente}.\n\n` +
    `Encontré ${cantidad === 1 ? 'una opción nueva' : `${cantidad} opciones nuevas`} en el mercado que podrían interesarte, según lo que estás buscando (${registro.tipo}, ${registro.zona}):\n\n` +
    `${linkPresentacion}\n\n` +
    `Escribime y te ayudo a coordinar la visita y la negociación.` +
    (contactoAgente ? `\n${nombreAgente} — ${contactoAgente}` : '');

  await enviarWhatsAppGHL(loc, registro.contactId, mensaje);
  return { mensaje, cantidad };
}

function rechazarEnvioCliente(agenteId, registroId) {
  const lista = leerEnviosClientes(agenteId);
  const idx = lista.findIndex((e) => e.id === registroId);
  if (idx === -1) return false;
  lista[idx].estado = 'rechazado';
  lista[idx].rechazadoEl = new Date().toISOString();
  fs.writeFileSync(archivoEnviosClientes(agenteId), JSON.stringify(lista, null, 2));
  return true;
}

// La página que ve el CLIENTE — solo lo que ya se le mandó (no vuelve a
// buscar en vivo, así no cambia después de enviado). Marca del agente,
// nunca datos del captador.
// Página de revisión — la abre el AGENTE (Ingrid) desde el link que le
// llega en el digest. Deschequeás lo que no sirva y aprobás; recién ahí sale
// el WhatsApp real al cliente. Sin login (mismo criterio de link no
// adivinable que la página del cliente) — pensada para abrirse desde el
// celular en un toque.
function paginaRevisionAgente(registro, agente) {
  const nombreAgente = escapeHtml((agente && agente.nombre) || 'Agente');
  if (registro.estado && registro.estado !== 'pendiente') {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ya procesado</title><style>body{font-family:system-ui,sans-serif;background:#0f1720;color:#e8ecf1;text-align:center;padding:60px 20px}</style></head>
    <body><h2>Este envío ya fue ${registro.estado === 'aprobado' ? 'aprobado y mandado' : 'rechazado'}.</h2></body></html>`;
  }
  const filas = (registro.propiedades || [])
    .map(
      (p, idx) => `
      <label class="item">
        <input type="checkbox" checked data-idx="${idx}">
        <img src="${escapeHtml(p.imagen || '')}" alt="" onerror="this.style.display='none'">
        <div class="detalle">
          <strong>${escapeHtml(p.titulo)}</strong>
          <span>US$ ${Number(p.precio || 0).toLocaleString('es-BO')} · ${escapeHtml(p.zona || '')} · ${escapeHtml(p.fuente || '')}</span>
          <span class="captador">Captador: ${escapeHtml(p.captadorNombre || 'sin datos')}${p.captadorTelefono ? ' — ' + escapeHtml(p.captadorTelefono) : ''}</span>
          ${p.link ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener">Ver aviso original ↗</a>` : ''}
        </div>
      </label>`
    )
    .join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revisar antes de enviar — ${escapeHtml(registro.cliente || '')}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1720;color:#e8ecf1;margin:0;padding:0}
  header{padding:20px;text-align:center;border-bottom:1px solid #1f2b38}
  header h1{margin:0 0 4px;font-size:18px}
  header p{margin:0;color:#8b9bab;font-size:13px}
  main{max-width:600px;margin:0 auto;padding:16px}
  .item{display:flex;gap:10px;background:#152230;border:1px solid #223244;border-radius:10px;padding:10px;margin-bottom:10px;align-items:flex-start;cursor:pointer}
  .item input{margin-top:6px;width:18px;height:18px;flex:none}
  .item img{width:64px;height:64px;object-fit:cover;border-radius:8px;flex:none;background:#0f1720}
  .detalle{display:flex;flex-direction:column;gap:2px;font-size:13px}
  .detalle strong{font-size:14px}
  .detalle span{color:#8b9bab}
  .captador{color:#e0a848 !important}
  .detalle a{color:#2dd4bf;font-size:12px}
  .botones{display:flex;gap:10px;margin-top:16px;position:sticky;bottom:0;background:#0f1720;padding:12px 0}
  button{flex:1;padding:14px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer}
  .aprobar{background:#2dd4bf;color:#0f1720}
  .rechazar{background:#2a1a1a;color:#e8ecf1;border:1px solid #4a2a2a}
  #estado{text-align:center;margin-top:12px;font-size:13px;color:#8b9bab}
</style></head>
<body>
  <header><h1>Revisar antes de enviar</h1><p>${escapeHtml(registro.cliente || '')} — ${escapeHtml(registro.tipo || '')}, ${escapeHtml(registro.zona || '')}</p></header>
  <main>
    <p style="color:#8b9bab;font-size:13px">Desmarcá lo que no valga la pena mandar. Al aprobar, el cliente recibe SOLO lo que quede marcado.</p>
    <div id="lista">${filas}</div>
    <div class="botones">
      <button class="rechazar" onclick="rechazar()">✕ No enviar nada</button>
      <button class="aprobar" onclick="aprobar()">✓ Aprobar y enviar</button>
    </div>
    <p id="estado"></p>
  </main>
  <script>
    const agenteId = ${JSON.stringify(registro.agenteId || '')};
    const id = ${JSON.stringify(registro.id)};
    function excluidos() {
      return Array.from(document.querySelectorAll('#lista input[type=checkbox]'))
        .filter(c => !c.checked).map(c => c.dataset.idx);
    }
    async function aprobar() {
      document.getElementById('estado').textContent = 'Enviando...';
      const res = await fetch('/api/envios-clientes/' + agenteId + '/' + id + '/aprobar', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ excluidos: excluidos() })
      });
      const data = await res.json();
      document.getElementById('estado').textContent = res.ok ? '✓ Enviado al cliente.' : ('Error: ' + (data.error || 'no se pudo'));
    }
    async function rechazar() {
      document.getElementById('estado').textContent = 'Rechazando...';
      const res = await fetch('/api/envios-clientes/' + agenteId + '/' + id + '/rechazar', { method: 'POST' });
      document.getElementById('estado').textContent = res.ok ? 'Rechazado, no se manda nada.' : 'Error al rechazar.';
    }
  </script>
</body></html>`;
}

function paginaPresentacionCliente(envio, agente) {
  const nombreAgente = escapeHtml((agente && agente.nombre) || 'Tu agente inmobiliario');
  const inmobiliaria = escapeHtml((agente && agente.inmobiliaria) || '');
  const contactoAgente = (agente && agente.telefonoContacto) || '';
  const waHref = contactoAgente ? `https://wa.me/${contactoAgente.replace(/[^\d]/g, '')}` : '';
  const tarjetas = (envio.propiedades || [])
    .map((p, idx) => {
      const fotos = Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes : p.imagen ? [p.imagen] : [];
      const galeria = fotos.length
        ? `<div class="galeria" data-card="${idx}">
            <img class="principal" src="${escapeHtml(fotos[0])}" alt="" loading="lazy">
            ${
              fotos.length > 1
                ? `<div class="miniaturas">${fotos
                    .map((f) => `<img src="${escapeHtml(f)}" alt="" loading="lazy" onclick="this.closest('.galeria').querySelector('.principal').src=this.src">`)
                    .join('')}</div>`
                : ''
            }
          </div>`
        : '<div class="sin-foto">Sin foto</div>';
      const caracteristicas = [
        p.dormitorios ? `${p.dormitorios} dorm.` : '',
        p.banos ? `${p.banos} baños` : '',
        p.m2Terreno ? `${p.m2Terreno} m² terreno` : '',
        p.m2Construccion ? `${p.m2Construccion} m² construidos` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const TOPE_DESC = 280;
      const descCorta = p.descripcion && p.descripcion !== p.titulo ? p.descripcion.slice(0, TOPE_DESC) : '';
      // Botón propio por propiedad — José Luis lo pidió el 2026-08-05: que
      // cada tarjeta tenga su "Agendar visita" con un WhatsApp pre-armado
      // mencionando ESA propiedad puntual, en vez de un solo botón genérico
      // al final de la página.
      const textoWa = encodeURIComponent(`Hola ${nombreAgente}! Me interesa esta propiedad: "${p.titulo}" (US$ ${Number(p.precio || 0).toLocaleString('es-BO')}). Quiero agendar una visita.`);
      const botonCard = waHref ? `<a class="cta-card" href="${waHref}?text=${textoWa}">Agendar visita 📅</a>` : '';
      return `
      <div class="card">
        ${galeria}
        <div class="info">
          <h3>${escapeHtml(p.titulo)}</h3>
          <p class="precio">US$ ${Number(p.precio || 0).toLocaleString('es-BO')}</p>
          ${p.zona ? `<p class="zona">${escapeHtml(p.zona)}</p>` : ''}
          ${caracteristicas ? `<p class="caracteristicas">${escapeHtml(caracteristicas)}</p>` : ''}
          ${descCorta ? `<p class="descripcion">${escapeHtml(descCorta)}${p.descripcion.length > TOPE_DESC ? '…' : ''}</p>` : ''}
          ${botonCard}
        </div>
      </div>`;
    })
    .join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opciones para ${escapeHtml(envio.cliente || '')} — ${nombreAgente}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1720;color:#e8ecf1;margin:0;padding:0}
  header{padding:24px 20px;text-align:center;border-bottom:1px solid #1f2b38}
  header h1{margin:0 0 4px;font-size:20px}
  header p{margin:0;color:#8b9bab;font-size:14px}
  main{max-width:960px;margin:0 auto;padding:24px 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:20px 0}
  .card{background:#152230;border-radius:12px;overflow:hidden;border:1px solid #223244}
  .galeria .principal{width:100%;height:170px;object-fit:cover;display:block;background:#0f1720}
  .miniaturas{display:flex;gap:4px;padding:4px;overflow-x:auto}
  .miniaturas img{width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;flex:none;opacity:.75}
  .miniaturas img:hover{opacity:1}
  .sin-foto{width:100%;height:170px;background:#1c2b3a;display:flex;align-items:center;justify-content:center;color:#5c6b7a;font-size:13px}
  .info{padding:12px}
  .info h3{margin:0 0 6px;font-size:15px;line-height:1.3}
  .precio{margin:0 0 4px;color:#2dd4bf;font-weight:700;font-size:16px}
  .zona{margin:0 0 4px;color:#8b9bab;font-size:13px}
  .caracteristicas{margin:0 0 6px;color:#c3ccd6;font-size:13px}
  .descripcion{margin:0;color:#8b9bab;font-size:12px;line-height:1.4}
  .cta{display:block;text-align:center;background:#2dd4bf;color:#0f1720;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;margin-top:8px}
  .cta-card{display:block;text-align:center;background:#1f3d3a;color:#2dd4bf;text-decoration:none;font-weight:600;padding:10px;border-radius:8px;margin-top:10px;font-size:13px}
  .cta-card:hover{background:#2dd4bf;color:#0f1720}
  footer{text-align:center;color:#5c6b7a;font-size:12px;padding:24px}
</style></head>
<body>
  <header><h1>${nombreAgente}${inmobiliaria ? ' — ' + inmobiliaria : ''}</h1><p>Opciones para ${escapeHtml(envio.cliente || 'vos')}</p></header>
  <main>
    <div class="grid">${tarjetas || '<p>No hay propiedades para mostrar.</p>'}</div>
    ${waHref ? `<a class="cta" href="${waHref}">Escribile a ${nombreAgente} por WhatsApp</a>` : ''}
  </main>
  <footer>Buscador de Inmuebles — Sofymar IA</footer>
</body></html>`;
}

// Página pública del reporte de zona (ver POST /api/reporte-zona más abajo).
// Mismo criterio de privacidad que paginaPresentacionCliente: nunca muestra
// el contacto ni el link del agente/portal original de cada aviso — solo la
// marca y el WhatsApp del agente dueño de la cuenta, para que el cliente
// siempre vuelva a él y no se salte a la competencia. La diferencia con
// paginaPresentacionCliente es que acá van TODAS las propiedades de la zona,
// no solo las que un requerimiento puntual aprobó.
function paginaReporteZona(reporte, agente) {
  const nombreAgente = escapeHtml((agente && agente.nombre) || 'Tu agente inmobiliario');
  const inmobiliaria = escapeHtml((agente && agente.inmobiliaria) || '');
  const contactoAgente = (agente && agente.telefonoContacto) || '';
  const waHref = contactoAgente ? `https://wa.me/${contactoAgente.replace(/[^\d]/g, '')}` : '';
  const criterio = [reporte.criterios?.operacion, reporte.criterios?.tipo]
    .filter(Boolean)
    .join(' en ');
  const subtitulo = [criterio, reporte.criterios?.zona ? 'en ' + reporte.criterios.zona : '']
    .filter(Boolean)
    .join(' ');
  const stats = reporte.resumen;
  const tarjetas = (reporte.propiedades || [])
    .map((p) => {
      const fotos = Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes : p.imagen ? [p.imagen] : [];
      const galeria = fotos.length
        ? `<div class="galeria"><img class="principal" src="${escapeHtml(fotos[0])}" alt="" loading="lazy"></div>`
        : '<div class="sin-foto">Sin foto</div>';
      const caracteristicas = [
        p.dormitorios ? `${p.dormitorios} dorm.` : '',
        p.banos ? `${p.banos} baños` : '',
        p.m2Terreno ? `${p.m2Terreno} m² terreno` : '',
        p.m2Construccion ? `${p.m2Construccion} m² constr.` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const textoWa = encodeURIComponent(`Hola ${nombreAgente}! Vi en tu reporte de ${reporte.criterios?.zona || 'la zona'} esta propiedad: "${p.titulo}" (US$ ${Number(p.precio || 0).toLocaleString('es-BO')}). Quiero más info.`);
      const botonCard = waHref ? `<a class="cta-card" href="${waHref}?text=${textoWa}">Consultar 📩</a>` : '';
      return `
      <div class="card">
        ${galeria}
        <div class="info">
          <h3>${escapeHtml(p.titulo)}</h3>
          <p class="precio">US$ ${Number(p.precio || 0).toLocaleString('es-BO')}</p>
          ${caracteristicas ? `<p class="caracteristicas">${escapeHtml(caracteristicas)}</p>` : ''}
          ${p.zona ? `<p class="zona">${escapeHtml(p.zona)}</p>` : ''}
          ${botonCard}
        </div>
      </div>`;
    })
    .join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opciones en ${escapeHtml(reporte.criterios?.zona || '')} — ${nombreAgente}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1720;color:#e8ecf1;margin:0;padding:0}
  header{padding:24px 20px;text-align:center;border-bottom:1px solid #1f2b38}
  header h1{margin:0 0 4px;font-size:20px}
  header p{margin:0;color:#8b9bab;font-size:14px}
  .stats{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;padding:16px 20px 0}
  .stat{background:#152230;border:1px solid #223244;border-radius:10px;padding:8px 14px;font-size:12.5px;color:#c3ccd6;text-align:center}
  .stat strong{display:block;color:#2dd4bf;font-size:16px}
  main{max-width:960px;margin:0 auto;padding:24px 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:20px 0}
  .card{background:#152230;border-radius:12px;overflow:hidden;border:1px solid #223244}
  .galeria .principal{width:100%;height:170px;object-fit:cover;display:block;background:#0f1720}
  .sin-foto{width:100%;height:170px;background:#1c2b3a;display:flex;align-items:center;justify-content:center;color:#5c6b7a;font-size:13px}
  .info{padding:12px}
  .info h3{margin:0 0 6px;font-size:15px;line-height:1.3}
  .precio{margin:0 0 4px;color:#2dd4bf;font-weight:700;font-size:16px}
  .zona{margin:0 0 4px;color:#8b9bab;font-size:13px}
  .caracteristicas{margin:0 0 6px;color:#c3ccd6;font-size:13px}
  .cta{display:block;text-align:center;background:#2dd4bf;color:#0f1720;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;margin-top:8px}
  .cta-card{display:block;text-align:center;background:#1f3d3a;color:#2dd4bf;text-decoration:none;font-weight:600;padding:10px;border-radius:8px;margin-top:10px;font-size:13px}
  .cta-card:hover{background:#2dd4bf;color:#0f1720}
  footer{text-align:center;color:#5c6b7a;font-size:12px;padding:24px}
</style></head>
<body>
  <header>
    <h1>${nombreAgente}${inmobiliaria ? ' — ' + inmobiliaria : ''}</h1>
    <p>${escapeHtml(subtitulo)}${reporte.tituloCliente ? ' — para ' + escapeHtml(reporte.tituloCliente) : ''}</p>
  </header>
  ${stats ? `<div class="stats">
    <div class="stat"><strong>${stats.cantidad}</strong>propiedades</div>
    ${stats.precioMin != null ? `<div class="stat"><strong>US$ ${stats.precioMin.toLocaleString('es-BO')}</strong>desde</div>` : ''}
    ${stats.precioMax != null ? `<div class="stat"><strong>US$ ${stats.precioMax.toLocaleString('es-BO')}</strong>hasta</div>` : ''}
    ${stats.precioM2Promedio != null ? `<div class="stat"><strong>US$ ${stats.precioM2Promedio}/m²</strong>promedio</div>` : ''}
  </div>` : ''}
  <main>
    <div class="grid">${tarjetas || '<p>No hay propiedades para mostrar.</p>'}</div>
    ${waHref ? `<a class="cta" href="${waHref}">Escribile a ${nombreAgente} por WhatsApp</a>` : ''}
  </main>
  <footer>Buscador de Inmuebles — Sofymar IA</footer>
</body></html>`;
}

let sincronizandoRequerimientosGHL = false;

async function sincronizarRequerimientosGHL() {
  if (sincronizandoRequerimientosGHL) return;
  const locations = leerLocationsGHL();
  if (!locations.length) return; // nada configurado en GHL_LOCATIONS todavía
  sincronizandoRequerimientosGHL = true;
  const estado = { sincronizadoEn: null, enProgreso: true, ultimoError: null };
  guardarEstadoGHL(estado);
  try {
    for (const loc of locations) {
      if (!loc.agenteId || !loc.locationId || !loc.token || !loc.requerimientoFieldId) {
        console.error('Entrada de GHL_LOCATIONS incompleta, se salta:', JSON.stringify(loc));
        continue;
      }
      try {
        const lista = leerRequerimientos(loc.agenteId);
        const porContactId = new Map(lista.filter((r) => r.contactId).map((r) => [r.contactId, r]));
        let cursor = null;
        let seguir = true;
        while (seguir) {
          const resp = await fetchContactosGHL(loc, cursor);
          const contactos = resp.contacts || [];
          for (const c of contactos) {
            const campo = (c.customFields || []).find((f) => f.id === loc.requerimientoFieldId);
            const texto = campo && Array.isArray(campo.value) ? campo.value.join(' ') : campo?.value;
            if (!texto || !texto.trim()) continue;
            const parseado = parsearRequerimientoLibre(texto);
            const existente = porContactId.get(c.id);
            const campos = camposRequerimiento({
              cliente: c.contactName || c.firstName || 'Lead de GHL',
              telefono: c.phone || '',
              operacion: 'venta',
              ...parseado,
            });
            // camposRequerimiento cae a 'casa' por defecto si no reconoce el
            // tipo — correcto para el form manual (siempre manda un tipo
            // real), pero acá tapaba en silencio los leads donde el bot no
            // capturó el tipo (bug real 2026-08-13: 7 de 15 leads reales
            // quedaron mal-etiquetados como "casa"). Si detectarTipoDesdeTexto
            // no encontró nada, se deja vacío a propósito — el barrido ya
            // sabe saltear requerimientos sin tipo en vez de buscar mal.
            if (!parseado.tipo) campos.tipo = '';
            porContactId.set(c.id, {
              ...campos,
              id: existente ? existente.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              creado: existente ? existente.creado : new Date().toISOString(),
              enviados: existente ? existente.enviados || [] : [],
              comentarios: existente ? existente.comentarios || [] : [],
              notificados: existente ? existente.notificados || [] : [],
              origen: 'ghl',
              contactId: c.id,
              locationId: loc.locationId,
            });
          }
          cursor = contactos.length ? contactos[contactos.length - 1].searchAfter : null;
          seguir = contactos.length === 100 && !!cursor;
        }
        // Reconstruir la lista: los que vinieron de GHL se reemplazan por su
        // versión actualizada (dedup por contactId vía el Map); los cargados
        // a mano (sin contactId) se preservan tal cual, sin tocarlos.
        const manuales = lista.filter((r) => !r.contactId);
        guardarRequerimientos([...manuales, ...porContactId.values()], loc.agenteId);
      } catch (e) {
        console.error('Error sincronizando requerimientos de GHL para', loc.agenteId, ':', e.message);
      }
    }
    estado.sincronizadoEn = new Date().toISOString();
  } catch (e) {
    estado.ultimoError = 'No se pudo sincronizar: ' + e.message;
  } finally {
    estado.enProgreso = false;
    guardarEstadoGHL(estado);
    sincronizandoRequerimientosGHL = false;
  }
}

let barriendoMatchesRequerimientos = false;

// Corre el barrido para UN solo agente (extraído aparte para poder
// reusarlo tanto en el barrido automático de todos los agentes como en el
// endpoint de admin que lo dispara a mano, ej. para una demo o para probar
// que un requerimiento puntual funciona sin esperar hasta 12h).
// Nunca notifica a otro agente ni a José Luis — solo al dueño del
// requerimiento, vía `agente.telefonoNotificaciones`.
async function barridoMatchesParaAgente(loc, agente, { forzar, soloRequerimientoId } = {}) {
  const resumen = { agenteId: loc.agenteId, requerimientosRevisados: 0, requerimientosIncompletos: 0, matchesNuevos: 0, emailsEnviados: 0, whatsappEnviados: 0, pendientesDeRevision: 0, clientesConError: 0, errores: [], detalle: [] };
  const telefono = agente && agente.telefonoNotificaciones;
  const correo = agente && agente.correoNotificaciones;
  // Se resuelve UNA sola vez por agente (no por requerimiento) para no
  // hacer un upsert de más por cada match — el destino de notificación es
  // siempre el mismo contacto durante todo este barrido.
  let contactId = null;
  if (telefono || correo) {
    try {
      contactId = await upsertContactoNotificacionesGHL(loc, { telefono, correo });
    } catch (e) {
      resumen.errores.push(`No se pudo resolver el contacto de notificaciones: ${e.message}`);
    }
  }
  // `soloRequerimientoId` (solo vía admin) acota la corrida a un único
  // requerimiento — para probar en vivo sin arriesgarse a mandarle mensajes
  // de prueba a leads reales que no lo esperan. OJO: la lista completa se
  // sigue leyendo y guardando entera (guardarRequerimientos más abajo) —
  // filtrar la lista misma acá borraría a todos los demás al guardar.
  const lista = leerRequerimientos(loc.agenteId);
  let cambios = false;
  // Se junta TODO acá y se manda UN solo correo/WhatsApp al final del
  // barrido (no uno por requerimiento) — antes cada requerimiento con match
  // mandaba su propio mensaje, y una corrida con varios requerimientos
  // activos terminaba mandando una ráfaga de correos casi simultáneos al
  // mismo destinatario, la señal más típica de spam para Gmail/Outlook.
  const pendientesRevision = [];
  for (const r of lista) {
    if (soloRequerimientoId && r.id !== soloRequerimientoId) continue;
    if (!r.zona || !r.tipo) {
      resumen.requerimientosIncompletos++;
      continue; // requerimiento incompleto (típico de texto libre de GHL a medio llenar) — nada confiable que buscar todavía
    }
    resumen.requerimientosRevisados++;
    let resultado;
    try {
      resultado = await buscarTodo(r);
    } catch (e) {
      resumen.errores.push(`${r.cliente}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    const notificados = new Set(r.notificados || []);
    // `forzar` (solo vía admin, para demo/prueba puntual) ignora el dedup y
    // trata todos los matches como nuevos — el barrido automático nunca lo usa.
    const nuevos = forzar ? resultado.listados : resultado.listados.filter((it) => !notificados.has(it.link || `${it.fuente}|${it.titulo}|${it.precio}`));
    if (nuevos.length) {
      for (const it of nuevos) notificados.add(it.link || `${it.fuente}|${it.titulo}|${it.precio}`);
      r.notificados = Array.from(notificados).slice(-500); // tope para que no crezca sin límite en requerimientos muy viejos
      cambios = true;
      resumen.matchesNuevos += nuevos.length;
      resumen.detalle.push({ cliente: r.cliente, zona: r.zona, tipo: r.tipo, matches: nuevos.map((it) => ({ titulo: it.titulo, precio: it.precio, fuente: it.fuente })) });
      for (const it of nuevos) {
        guardarAlerta(loc.agenteId, {
          origen: 'barrido-periodico',
          propiedad: { titulo: it.titulo, precio: it.precio, zona: it.zona, tipo: it.tipo, operacion: it.operacion, link: it.link || '' },
          requerimiento: { id: r.id, cliente: r.cliente, telefono: r.telefono, zona: r.zona, precioMin: r.precioMin, precioMax: r.precioMax },
        });
      }
      // Ya NO se manda directo al cliente — pedido explícito de José Luis
      // (2026-08-05): "la IA puede fallar", así que se arma la propuesta en
      // estado pendiente y el agente la aprueba desde la página de revisión
      // que le llega en el digest de abajo. Recién ahí sale el WhatsApp real.
      if (r.telefono || r.contactId) {
        try {
          const registroPendiente = await prepararRevisionCliente(loc, agente, r, nuevos);
          resumen.pendientesDeRevision++;
          pendientesRevision.push({ requerimiento: r, registro: registroPendiente });
        } catch (e) {
          resumen.clientesConError++;
          resumen.errores.push(`Cliente ${r.cliente}: ${e.message}`);
        }
      }
    }
    // Pausa entre requerimientos para no golpear C21/RE-MAX/BienInmuebles en ráfaga (ya nos bloquearon una vez por esto).
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (cambios) guardarRequerimientos(lista, loc.agenteId);

  // Ya no se manda el listado de propiedades en el digest — cada
  // requerimiento con matches queda `pendiente` y lo que se manda acá es el
  // link para REVISAR Y APROBAR antes de que salga algo al cliente (pedido
  // de José Luis, 2026-08-05: "la IA puede fallar").
  if (pendientesRevision.length && contactId) {
    const TOPE_REQUERIMIENTOS = 8;
    const seccionesTxt = [];
    const seccionesHtml = [];
    for (const { requerimiento: r, registro } of pendientesRevision.slice(0, TOPE_REQUERIMIENTOS)) {
      const linkRevision = `${BASE_URL_APP}/revisar/${agente.id}/${registro.id}`;
      const cantidad = registro.propiedades.length;
      seccionesTxt.push(`${r.cliente} (${r.zona}, ${r.tipo}) — ${cantidad} opción(es) para revisar:\n${linkRevision}`);
      seccionesHtml.push(
        `<p style="margin:0 0 4px"><strong>${escapeHtml(r.cliente)}</strong> — ${escapeHtml(r.zona)}, ${escapeHtml(r.tipo)} — ${cantidad} opción(es)</p>` +
          `<p style="margin:0 0 16px"><a href="${linkRevision}">Revisar y aprobar →</a></p>`
      );
    }
    const restantes = pendientesRevision.length - Math.min(pendientesRevision.length, TOPE_REQUERIMIENTOS);
    const pieTxt = (restantes > 0 ? `\n…y ${restantes} requerimiento(s) más con novedades — entrá al Buscador de Inmuebles.\n\n` : '\n') + 'Buscador de Inmuebles — Sofymar IA';
    const pieHtml =
      (restantes > 0 ? `<p>…y ${restantes} requerimiento(s) más con novedades — entrá al Buscador de Inmuebles.</p>` : '') +
      `<p style="color:#888;font-size:12px">Buscador de Inmuebles — Sofymar IA</p>`;
    const asunto =
      pendientesRevision.length === 1
        ? `Revisar antes de enviar — ${pendientesRevision[0].requerimiento.cliente}`
        : `Revisar antes de enviar — ${pendientesRevision.length} clientes`;
    const mensajeTxt = seccionesTxt.join('\n\n') + pieTxt;
    const mensajeHtml = seccionesHtml.join('') + pieHtml;
    if (correo) {
      try {
        await enviarEmailGHL(loc, contactId, correo, asunto, mensajeHtml, true);
        resumen.emailsEnviados++;
      } catch (e) {
        resumen.errores.push(`Email a ${loc.agenteId}: ${e.message}`);
      }
    }
    if (telefono) {
      try {
        await enviarWhatsAppGHL(loc, contactId, `🔎 ${asunto}:\n\n${mensajeTxt}`);
        resumen.whatsappEnviados++;
      } catch (e) {
        // No se cuenta como error "real" del sistema — es esperable que falle por la ventana de 24h de WhatsApp.
        resumen.whatsappFallos = (resumen.whatsappFallos || 0) + 1;
      }
    }
  }
  return resumen;
}

// A diferencia de matchearContraTodosLosAgentes (que solo reacciona cuando
// aparece una propiedad genuinamente NUEVA en el caché de Mobiliario App),
// este barrido vuelve a buscar activamente en las 4 fuentes para CADA
// requerimiento activo — así un requerimiento nuevo también se cruza contra
// el inventario que YA existía en C21/RE-MAX/BienInmuebles (fuentes en vivo,
// sin caché histórica propia). Corre cada 12h (ver setInterval en el arranque).
async function barridoMatchesRequerimientos() {
  if (barriendoMatchesRequerimientos) return;
  barriendoMatchesRequerimientos = true;
  try {
    const locations = leerLocationsGHL();
    const agentes = leerAgentes();
    for (const loc of locations) {
      if (!loc.agenteId || !loc.locationId || !loc.token) continue;
      const agente = agentes.find((a) => a.id === loc.agenteId);
      try {
        await barridoMatchesParaAgente(loc, agente);
      } catch (e) {
        console.error('Barrido de matches: error con', loc.agenteId, '—', e.message);
      }
    }
  } catch (e) {
    console.error('Error en barrido de matches de requerimientos:', e.message);
  } finally {
    barriendoMatchesRequerimientos = false;
  }
}

function chequearResyncRequerimientosGHL() {
  if (!leerLocationsGHL().length) return; // GHL_LOCATIONS no configurado — nada que hacer
  const estado = leerEstadoGHL();
  const horasDesdeUltimaSync = estado.sincronizadoEn
    ? (Date.now() - new Date(estado.sincronizadoEn).getTime()) / 3600000
    : Infinity;
  if (!estado.enProgreso && horasDesdeUltimaSync >= GHL_RESYNC_HORAS) {
    console.log('Sincronizando requerimientos de GHL en segundo plano…');
    sincronizarRequerimientosGHL().catch((e) => console.error('Error sincronizando requerimientos de GHL:', e));
  }
}

// Lee de la caché ya sincronizada (rápido, sin red) y filtra por lo que pide
// este requerimiento — el mismo patrón de "traer todo y filtrar local" que
// las otras 3 fuentes, salvo que acá "traer todo" ya pasó en segundo plano.
async function fetchMobiliario(req, tc) {
  const cache = leerCacheMobiliario();
  if (!cache.sincronizadoEn && !cache.progreso) {
    throw new Error(
      cache.ultimoError || 'Todavía no se sincronizó por primera vez (puede tardar bastante con ~7.900 propiedades) — ya está en camino en segundo plano.'
    );
  }
  const items = Object.values(cache.listados)
    .map((v) => v.item)
    .filter((it) => it && it.operacion === req.operacion && it.tipo === req.tipo);
  // Conversión a US$ acá (no al sincronizar) para usar siempre el tipo de
  // cambio vigente de la búsqueda — mismo criterio que BienInmuebles.
  return items.map((it) => {
    let precio = it.precioCrudo == null ? null : it.monedaCrudo === 'bob' ? Math.round(it.precioCrudo / tc) : it.precioCrudo;
    // Se descarta lo implausible, mismo criterio que normalizarC21 (umbralTypo).
    // Bug real encontrado 2026-08-14: el propio schema.org de Mobiliario App a
    // veces trunca el precio (ej. una casa con descripción "Precio: $30.000"
    // pero offers.price=30, perdiendo el ".000") — sin este filtro esos avisos
    // rotos se iban primeros al ordenar por precio, tapando los resultados reales.
    const umbralTypo = it.operacion === 'alquiler' ? 10 : 1000;
    if (precio != null && precio < umbralTypo) precio = null;
    return { ...it, precio };
  });
}

// ---------- CapitalCorp (capitalcorp.com.bo) ----------
// 5ta fuente, pedida por José Luis el 2026-08-18 ("necesito abarcar todo").
// Tema WordPress "classifiedengine": no hay API de búsqueda masiva ni
// schema.org por aviso (a diferencia de Mobiliario App), así que se arma
// igual que esa: sincronización en segundo plano + caché local, las
// búsquedas leen de la caché. Dos pasos:
//  1) Un único pedido público a su endpoint de mapa (admin-ajax.php,
//     explícitamente permitido en robots.txt: "Allow: /wp-admin/admin-ajax.php")
//     trae los ~98 avisos vigentes de una sola vez (título, foto, lat/lon,
//     ubicación, link) — es el mismo pedido que usa el mapa de su propia
//     página de inicio.
//  2) Por cada aviso se visita su página individual (con pausa entre
//     tandas, igual que Mobiliario App) para sacar precio, tipo, m²,
//     dormitorios/baños y nombre del agente — no vienen en el paso 1.
// El TELÉFONO se deja deliberadamente vacío: confirmado inspeccionando el
// DOM que el sitio ofusca el número a propósito (dígitos reales
// intercalados con dígitos "decoy" ocultos con CSS display:none) — es una
// protección anti-scraping explícita, no un dato que simplemente falte, y
// no se intenta esquivarla. El agente puede conseguir el teléfono real
// abriendo el link directo del aviso, igual que con cualquier otra fuente
// sin contacto expuesto.
const CAPITALCORP_CACHE_FILE = path.join(DATA_DIR, 'cache-capitalcorp.json');
const CAPITALCORP_LOTE = 4;
const CAPITALCORP_PAUSA_MS = 400;
const CAPITALCORP_MAX_FALLOS_SEGUIDOS = 8;
const CAPITALCORP_RESYNC_HORAS = 6;

function leerCacheCapitalCorp() {
  try {
    return JSON.parse(fs.readFileSync(CAPITALCORP_CACHE_FILE, 'utf8'));
  } catch {
    return { sincronizadoEn: null, enProgreso: false, ultimoError: null, listados: {} };
  }
}

function guardarCacheCapitalCorp(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CAPITALCORP_CACHE_FILE, JSON.stringify(cache));
}

// Formato boliviano de números: punto de miles, coma decimal (ej.
// "185.000,00" -> 185000). Se usa tanto para precio como para m².
function parsearNumeroBoliviano(texto) {
  if (texto == null) return null;
  const limpio = String(texto).replace(/\./g, '').replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

function tipoDesdeTextoCapitalCorp(texto) {
  if (/terrenos?/i.test(texto)) return 'terreno';
  if (/departamentos?|depto\b/i.test(texto)) return 'departamento';
  if (/oficinas?/i.test(texto)) return 'oficina';
  if (/locales?(\s+comerciales?)?/i.test(texto)) return 'local';
  if (/edificios?/i.test(texto)) return 'edificio';
  if (/galp(o|ó)n(es)?/i.test(texto)) return 'deposito';
  if (/quintas?/i.test(texto)) return 'quinta';
  if (/casas?/i.test(texto)) return 'casa';
  return null;
}

// Pedido único público al endpoint de mapa del tema — trae TODOS los avisos
// vigentes de una vez (confirmado: count=98 al 2026-08-18).
async function obtenerListadoCapitalCorp() {
  const res = await fetch('https://capitalcorp.com.bo/wp-admin/admin-ajax.php?action=ce_cemap_fetch_ads', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error('Respuesta inesperada de CapitalCorp');
  return data.data;
}

async function sincronizarUnaPropiedadCapitalCorp(basica) {
  const html = await fetchTexto(basica.permalink);
  const excerptTexto = (basica.post_excerpt || '').replace(/<[^>]+>/g, ' ');
  const tipo = tipoDesdeTextoCapitalCorp(basica.post_title) || tipoDesdeTextoCapitalCorp(excerptTexto);
  if (!tipo) return null; // categoría no reconocida — se descarta, no se adivina
  // Bug real encontrado probando en vivo (2026-08-19): el título no siempre
  // dice "alquiler" — muchos avisos dicen "ALQUILO" ("Alquilo departamento
  // amoblado"), que no matcheaba y los dejaba mal clasificados como venta
  // (y con precio de alquiler real, ej. $450, descartado después por el
  // filtro de cordura de venta). "alquil" cubre alquiler/alquilo/alquila/alquilan.
  const operacion = /alquil/i.test(basica.post_title + ' ' + excerptTexto) ? 'alquiler' : 'venta';

  // El precio vive en <div class="price-product">...<span>$185.000,00</span></div>.
  const mPrecio = html.match(/class="price-product"[\s\S]{0,400}?>\s*(\$[\d.,]+)\s*<\/span>/i);
  let precio = mPrecio ? parsearNumeroBoliviano(mPrecio[1].replace('$', '')) : null;
  // Mismo filtro de cordura que las otras fuentes (normalizarC21/fetchMobiliario):
  // descarta precios implausibles (typos, placeholders sin completar).
  const umbralTypo = operacion === 'alquiler' ? 10 : 1000;
  if (precio != null && precio < umbralTypo) precio = null;

  // El tema muestra sus "campos extra" (Superficie, Dormitorios, Baños...)
  // todos con la misma estructura <label>Nombre: </label><span
  // class="ext-field-value">valor</span> — se leen todos de una vez sin
  // asumir cuáles están presentes en cada aviso puntual.
  const campos = {};
  for (const m of html.matchAll(/<label[^>]*>([^<:]+):\s*<\/label>\s*<span class="ext-field-value[^"]*"[^>]*>([^<]*)<\/span>/gi)) {
    campos[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const superficie = parsearNumeroBoliviano(campos['superficie']);
  const dormitorios = parsearNumeroBoliviano(campos['dormitorios'] || campos['habitaciones']);
  const banos = parsearNumeroBoliviano(campos['baños'] || campos['banos']);

  const mAgente = html.match(/class="[^"]*seller-name[^"]*"[^>]*>([^<]+)</i);
  // Fecha real de publicación no está disponible — el sitio solo muestra
  // "hace N días" en la propia página, se convierte a fecha aproximada para
  // que el filtro de antigüedad de la app pueda usarlo como las otras fuentes.
  const mDias = html.match(/hace\s+(\d+)\s+d[ií]as?/i);
  const fecha = mDias ? new Date(Date.now() - Number(mDias[1]) * 86400000).toISOString() : null;

  return {
    fuente: 'CapitalCorp',
    operacion,
    tipo,
    titulo: basica.post_title || '(sin título)',
    precio,
    dormitorios: dormitorios > 0 ? dormitorios : null,
    banos: banos > 0 ? banos : null,
    m2Terreno: tipo === 'terreno' ? superficie : null,
    m2Construccion: tipo !== 'terreno' ? superficie : null,
    zona: basica.location || '',
    direccion: '',
    lat: basica.lat ? Number(basica.lat) : null,
    lon: basica.lng ? Number(basica.lng) : null,
    imagen: basica.logo || null,
    imagenes: basica.logo ? [basica.logo] : [],
    link: basica.permalink,
    descripcion: excerptTexto.replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
    oficina: '',
    fecha,
    asesor: mAgente ? mAgente[1].trim() : '',
    whatsapp: '',
    telefono: '',
    email: '',
  };
}

let sincronizandoCapitalCorp = false;

// Solo 98 avisos (vs. ~7.900 de Mobiliario App), así que a diferencia de esa
// no vale la pena la complejidad de comparar fechas de modificación — cada
// sincronización revisita todo, es barato. Progreso previo se preserva por
// si se corta a mitad de camino (mismo criterio: no perder lo ya bueno).
async function sincronizarCapitalCorp() {
  if (sincronizandoCapitalCorp) return;
  sincronizandoCapitalCorp = true;
  const cache = leerCacheCapitalCorp();
  cache.enProgreso = true;
  cache.ultimoError = null;
  try {
    const listado = await obtenerListadoCapitalCorp();
    const porLink = { ...cache.listados };
    let fallosSeguidos = 0;
    for (let i = 0; i < listado.length; i += CAPITALCORP_LOTE) {
      const tanda = listado.slice(i, i + CAPITALCORP_LOTE);
      const resultados = await Promise.all(
        tanda.map(async (b) => {
          try {
            const item = await sincronizarUnaPropiedadCapitalCorp(b);
            fallosSeguidos = 0;
            return { link: b.permalink, item };
          } catch (e) {
            fallosSeguidos++;
            return { link: b.permalink, error: e.message };
          }
        })
      );
      for (const r of resultados) {
        if (r.item) porLink[r.link] = r.item;
      }
      cache.listados = porLink;
      cache.progreso = { procesados: Math.min(i + CAPITALCORP_LOTE, listado.length), total: listado.length };
      guardarCacheCapitalCorp(cache);
      if (fallosSeguidos >= CAPITALCORP_MAX_FALLOS_SEGUIDOS) {
        cache.ultimoError = `Se detuvo tras ${fallosSeguidos} fallos seguidos (posible bloqueo de capitalcorp.com.bo) — quedó con ${Object.keys(porLink).length} de ${listado.length} propiedades.`;
        break;
      }
      await new Promise((r) => setTimeout(r, CAPITALCORP_PAUSA_MS));
    }
    // Solo se podan los que ya no están si la corrida terminó completa —
    // si se cortó por fallos seguidos, no hay forma de saber si el resto
    // sigue vigente, así que se deja como estaba.
    if (fallosSeguidos < CAPITALCORP_MAX_FALLOS_SEGUIDOS) {
      const linksVigentes = new Set(listado.map((b) => b.permalink));
      for (const link of Object.keys(porLink)) {
        if (!linksVigentes.has(link)) delete porLink[link];
      }
    }
    cache.listados = porLink;
    cache.sincronizadoEn = new Date().toISOString();
  } catch (e) {
    cache.ultimoError = 'No se pudo sincronizar: ' + e.message;
  } finally {
    cache.enProgreso = false;
    guardarCacheCapitalCorp(cache);
    sincronizandoCapitalCorp = false;
  }
}

// Lee de la caché ya sincronizada (rápido, sin red) — mismo patrón que fetchMobiliario.
async function fetchCapitalCorp(req) {
  const cache = leerCacheCapitalCorp();
  if (!cache.sincronizadoEn && !cache.progreso) {
    throw new Error(cache.ultimoError || 'Todavía no se sincronizó por primera vez — ya está en camino en segundo plano.');
  }
  return Object.values(cache.listados).filter((it) => it && it.operacion === req.operacion && it.tipo === req.tipo);
}

// ---------- Alfa Bolivia (alfa.bo) ----------
// 6ta fuente, pedida por José Luis el 2026-08-25 tras analizar a un
// competidor (Bolivia Inmuebles) que la usa como una de sus fuentes.
// robots.txt sin restricciones. Es Next.js App Router (RSC) — no hay API
// REST limpia, pero la propia página de listado (`/propiedades?page=N`, sin
// JS) ya trae CADA propiedad con todos sus datos (precio, m², dormitorios,
// baños, agente, oficina, foto) embebida en el HTML — no hace falta visitar
// la ficha individual de cada una, a diferencia de CapitalCorp/Mobiliario.
// El dato viene dentro del payload interno de Next (`self.__next_f.push(...)`)
// con las comillas escapadas UNA vez (`\"clave\":`) porque es JSON dentro de
// un string JS — se extrae haciendo balanceo manual de llaves (ignorando lo
// que esté "dentro de comillas") y después desescapando `\"`→`"` y `\\`→`\`
// antes de JSON.parse. Es más frágil que una API documentada (depende del
// build interno de Next.js, puede cambiar sin aviso), pero es la única vía
// real disponible — igual que CapitalCorp, que tampoco tiene API limpia.
const ALFABOLIVIA_CACHE_FILE = path.join(DATA_DIR, 'cache-alfabolivia.json');
const ALFABOLIVIA_PAGINAS_MAX = 250; // techo de seguridad (~185 páginas reales vistas el 2026-08-25)
const ALFABOLIVIA_LOTE = 5;
const ALFABOLIVIA_PAUSA_MS = 300;
const ALFABOLIVIA_RESYNC_HORAS = 6;

function leerCacheAlfaBolivia() {
  try {
    return JSON.parse(fs.readFileSync(ALFABOLIVIA_CACHE_FILE, 'utf8'));
  } catch {
    return { sincronizadoEn: null, enProgreso: false, ultimoError: null, listados: {} };
  }
}

function guardarCacheAlfaBolivia(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ALFABOLIVIA_CACHE_FILE, JSON.stringify(cache));
}

function tipoDesdeTextoAlfaBolivia(texto) {
  if (/terreno/i.test(texto)) return 'terreno';
  if (/departamento/i.test(texto)) return 'departamento';
  if (/oficina/i.test(texto)) return 'oficina';
  if (/local/i.test(texto)) return 'local';
  if (/edificio/i.test(texto)) return 'edificio';
  if (/galp(o|ó)n/i.test(texto)) return 'deposito';
  if (/quinta/i.test(texto)) return 'quinta';
  if (/casa/i.test(texto)) return 'casa';
  return null;
}

// Extrae cada objeto `{"slug": ...}` embebido en el HTML crudo de una
// página de listado. Busca la apertura real de llaves (`lastIndexOf('{', …)`
// desde el marcador `"slug":`, no asume que "slug" sea la primera clave),
// balancea llaves ignorando lo que esté dentro de comillas (y saltea
// cualquier char escapado con `\`, incluida la propia `\"`), y recién ahí
// desescapa y parsea. Si el formato interno de Next.js cambia algún día y
// esto deja de encontrar objetos, se degrada solo (0 resultados, no rompe
// nada) — ver fetchAlfaBolivia más abajo.
function extraerPropiedadesAlfaBolivia(html) {
  const marcador = '\\"slug\\":';
  const objetos = [];
  let i = 0;
  while (true) {
    const real = html.indexOf(marcador, i);
    if (real === -1) break;
    const inicioObj = html.lastIndexOf('{', real);
    if (inicioObj === -1) {
      i = real + marcador.length;
      continue;
    }
    let profundidad = 0;
    let j = inicioObj;
    let dentroString = false;
    for (; j < html.length; j++) {
      const c = html[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '"') {
        dentroString = !dentroString;
        continue;
      }
      if (!dentroString) {
        if (c === '{') profundidad++;
        else if (c === '}') {
          profundidad--;
          if (profundidad === 0) {
            j++;
            break;
          }
        }
      }
    }
    const crudo = html.slice(inicioObj, j);
    const limpio = crudo.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    try {
      objetos.push(JSON.parse(limpio));
    } catch {
      // objeto roto/incompleto (borde de página, truncado) — se descarta, no rompe el resto
    }
    i = j > real ? j : real + marcador.length;
  }
  return objetos;
}

async function obtenerPaginaAlfaBolivia(pagina) {
  const html = await fetchTexto(`https://alfa.bo/propiedades?orden=reciente&page=${pagina}`);
  return extraerPropiedadesAlfaBolivia(html);
}

// Una propiedad de Alfa puede tener varias operaciones a la vez (venta Y
// alquiler) — se genera UN item normalizado por cada operación reconocida,
// cada uno con su propio precio/moneda (mismo criterio que si fueran avisos
// separados, ya que así los trata el resto de la app).
function normalizarAlfaBolivia(p) {
  const tipo = tipoDesdeTextoAlfaBolivia(p.tipo_inmueble || '');
  if (!tipo || p.departamento !== 'Santa Cruz') return [];
  const superficie = p.superficie_total != null ? Math.round(Number(p.superficie_total)) : null;
  const items = [];
  for (const op of p.operaciones || []) {
    const operacion = /alquiler/i.test(op.tipo_operacion || '') ? 'alquiler' : /venta/i.test(op.tipo_operacion || '') ? 'venta' : null;
    if (!operacion) continue; // ej. "Anticrético" — no es venta ni alquiler tal como los maneja la app
    items.push({
      fuente: 'Alfa Bolivia',
      operacion,
      tipo,
      titulo: p.meta_title || `${p.tipo_inmueble} en ${operacion === 'alquiler' ? 'alquiler' : 'venta'}${p.zona ? ' en ' + p.zona : ''}`,
      precioCrudo: op.precio != null ? Math.round(Number(op.precio)) : null,
      monedaCrudo: String(op.moneda || 'USD').toUpperCase() === 'BOB' ? 'bob' : 'usd',
      dormitorios: p.habitaciones > 0 ? p.habitaciones : null,
      banos: p.banos > 0 ? p.banos : null,
      m2Terreno: tipo === 'terreno' ? superficie : null,
      m2Construccion: tipo !== 'terreno' ? superficie : null,
      zona: [p.zona, p.municipio].filter(Boolean).join(', '),
      direccion: p.nombre_calle || '',
      lat: null,
      lon: null,
      imagen: p.portada?.url || null,
      imagenes: p.portada?.url ? [p.portada.url] : [],
      link: `https://alfa.bo/propiedades/${p.slug}`,
      descripcion: '',
      oficina: p.agencia?.nombre || '',
      fecha: null,
      asesor: p.agente?.name || '',
      whatsapp: '',
      telefono: '',
      // Alfa no expone teléfono en el listado — sí un email de contacto del
      // agente (usuario de su plataforma interna), único de las 6 fuentes
      // que trae esto en vez de un teléfono.
      email: p.agente?.username || '',
    });
  }
  return items;
}

let sincronizandoAlfaBolivia = false;

async function sincronizarAlfaBolivia() {
  if (sincronizandoAlfaBolivia) return;
  sincronizandoAlfaBolivia = true;
  const cache = leerCacheAlfaBolivia();
  cache.enProgreso = true;
  cache.ultimoError = null;
  try {
    const porClave = {};
    let fallosSeguidos = 0;
    let terminado = false;
    for (let p = 1; p <= ALFABOLIVIA_PAGINAS_MAX && !terminado; p += ALFABOLIVIA_LOTE) {
      const tanda = [];
      for (let k = 0; k < ALFABOLIVIA_LOTE && p + k <= ALFABOLIVIA_PAGINAS_MAX; k++) tanda.push(p + k);
      const resultados = await Promise.all(
        tanda.map(async (pagina) => {
          try {
            const props = await obtenerPaginaAlfaBolivia(pagina);
            fallosSeguidos = 0;
            return { pagina, props };
          } catch (e) {
            fallosSeguidos++;
            return { pagina, error: e.message };
          }
        })
      );
      let algunaConDatos = false;
      for (const r of resultados) {
        if (r.props && r.props.length) {
          algunaConDatos = true;
          for (const prop of r.props) {
            for (const item of normalizarAlfaBolivia(prop)) {
              // clave única por aviso+operación (un mismo slug puede generar 2 items si tiene venta y alquiler)
              porClave[`${prop.slug}|${item.operacion}`] = item;
            }
          }
        }
      }
      // Ninguna página de la tanda trajo propiedades = se acabó el catálogo
      // (llegamos más allá de la última página real) — no es un error.
      if (!algunaConDatos) terminado = true;

      cache.listados = porClave;
      cache.progreso = { procesados: Math.min(p + ALFABOLIVIA_LOTE - 1, ALFABOLIVIA_PAGINAS_MAX), total: ALFABOLIVIA_PAGINAS_MAX };
      guardarCacheAlfaBolivia(cache);

      if (fallosSeguidos >= 8) {
        cache.ultimoError = `Se detuvo tras ${fallosSeguidos} fallos seguidos — quedó con ${Object.keys(porClave).length} avisos.`;
        break;
      }
      await new Promise((r) => setTimeout(r, ALFABOLIVIA_PAUSA_MS));
    }
    cache.listados = porClave;
    cache.sincronizadoEn = new Date().toISOString();
  } catch (e) {
    cache.ultimoError = 'No se pudo sincronizar: ' + e.message;
  } finally {
    cache.enProgreso = false;
    guardarCacheAlfaBolivia(cache);
    sincronizandoAlfaBolivia = false;
  }
}

async function fetchAlfaBolivia(req, tc) {
  const cache = leerCacheAlfaBolivia();
  if (!cache.sincronizadoEn && !cache.progreso) {
    throw new Error(cache.ultimoError || 'Todavía no se sincronizó por primera vez — ya está en camino en segundo plano.');
  }
  const items = Object.values(cache.listados).filter((it) => it && it.operacion === req.operacion && it.tipo === req.tipo);
  return items.map((it) => {
    let precio = it.precioCrudo == null ? null : it.monedaCrudo === 'bob' ? Math.round(it.precioCrudo / tc) : it.precioCrudo;
    const umbralTypo = it.operacion === 'alquiler' ? 10 : 1000;
    if (precio != null && precio < umbralTypo) precio = null;
    return { ...it, precio };
  });
}

// ---------- Matching de 1 propiedad contra 1 requerimiento ----------
// Extraído de buscarTodo (antes vivía inline en su cadena de .filter()) para
// poder reusarlo comparando UNA propiedad nueva (ficha cargada a mano, o un
// item nuevo detectado en la sincronización de Mobiliario App) contra los
// requerimientos guardados, sin tener que rearmar una búsqueda completa.
// Muta el item con cercaPresupuesto/destaca (mismo criterio que antes) y
// devuelve true/false según si la propiedad matchea el requerimiento.
// buscarTodo la usa para comparar N propiedades contra 1 solo req (el
// formulario de búsqueda); la sincronización GHL/Mobiliario la usa al revés,
// 1 propiedad contra N requerimientos guardados — misma función en ambos casos.
function matcheaPropiedad(item, req) {
  const zonas = parseZonas(req.zona);
  if (zonas.length && !zonas.some((z) => zonaMatch(item, z))) return false;

  const { precioMinUsd, precioMaxUsd } = convertirPresupuesto(req);
  const MARGEN_PRECIO = 0.12;
  const precioMinConMargen = precioMinUsd ? Math.round(precioMinUsd * (1 - MARGEN_PRECIO)) : null;
  const precioMaxConMargen = precioMaxUsd ? Math.round(precioMaxUsd * (1 + MARGEN_PRECIO)) : null;
  if (precioMinConMargen && (item.precio == null || item.precio < precioMinConMargen)) return false;
  if (precioMaxConMargen && (item.precio == null || item.precio > precioMaxConMargen)) return false;
  item.cercaPresupuesto =
    item.precio != null &&
    ((precioMinUsd != null && item.precio < precioMinUsd) || (precioMaxUsd != null && item.precio > precioMaxUsd));

  if (req.dormitorios && APLICA_DORMITORIOS.has(req.tipo)) {
    if (item.dormitorios == null || item.dormitorios < Number(req.dormitorios)) return false;
  }
  if (req.banos) {
    if (item.banos == null || item.banos < Number(req.banos)) return false;
  }

  const mtMin = parsePrecio(req.m2TerrenoMin);
  const mtMax = parsePrecio(req.m2TerrenoMax);
  const mcMin = parsePrecio(req.m2ConstruccionMin);
  const mcMax = parsePrecio(req.m2ConstruccionMax);
  if (mtMin && (item.m2Terreno == null || item.m2Terreno < mtMin)) return false;
  if (mtMax && (item.m2Terreno == null || item.m2Terreno > mtMax)) return false;
  if (mcMin && (item.m2Construccion == null || item.m2Construccion < mcMin)) return false;
  if (mcMax && (item.m2Construccion == null || item.m2Construccion > mcMax)) return false;

  const antiguedadMaxDias = req.antiguedadMaxDias ? Number(req.antiguedadMaxDias) : null;
  if (antiguedadMaxDias) {
    const corte = Date.now() - antiguedadMaxDias * 24 * 60 * 60 * 1000;
    if (item.fecha && new Date(item.fecha).getTime() < corte) return false;
  }

  const excluir = (req.excluir || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (excluir.length && excluir.some((p) => quitarAcentos(textoItem(item)).includes(quitarAcentos(p)))) return false;

  const destacar = (req.palabras || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  item.destaca = destacar.some((p) => quitarAcentos(textoItem(item)).includes(quitarAcentos(p)));
  if (destacar.length && req.filtroEstricto === '1' && !item.destaca) return false;

  return true;
}

// ---------- Fusión de duplicados entre fuentes ----------
// José Luis lo pidió el 2026-08-19 ("mejoralo que sea efectivo") después de
// que el análisis manual de Urubó Golf mostró el mismo terreno publicado en
// RE/MAX Y en Mobiliario App: mismo precio, misma superficie, mismas
// coordenadas hasta el 7mo decimal — es literalmente el mismo aviso
// republicado por el mismo captador (o replicado por el propio portal) en
// dos portales distintos. Sin fusionar, el agente ve la "misma" propiedad
// dos veces y la lista se siente más desordenada/redundante de lo que es.
//
// Deliberadamente conservador — un falso fusionado (esconder dos
// propiedades DISTINTAS como si fueran una) es peor que un falso no-
// fusionado (mostrar un duplicado real dos veces), así que exige evidencia
// fuerte: mismo precio EXACTO siempre, más:
//   - coordenadas casi idénticas (< ~30m de distancia), o
//   - si no hay coordenadas útiles en alguno, mismo m² (terreno o
//     construcción según corresponda) hasta el metro.
// Nunca fusiona dentro de la MISMA fuente (eso ya lo resuelve/no debería
// pasar en el fetch de esa fuente puntual).
const TOLERANCIA_COORD_DUPLICADO = 0.0003; // ~30m

function esMismoInmueble(a, b) {
  if (a.fuente === b.fuente) return false;
  if (a.precio == null || b.precio == null || a.precio !== b.precio) return false;
  if (a.lat && a.lon && b.lat && b.lon) {
    const dist = Math.hypot(a.lat - b.lat, a.lon - b.lon);
    if (dist < TOLERANCIA_COORD_DUPLICADO) return true;
  }
  const m2a = a.m2Terreno ?? a.m2Construccion;
  const m2b = b.m2Terreno ?? b.m2Construccion;
  if (m2a != null && m2b != null && Math.abs(m2a - m2b) < 1) return true;
  return false;
}

// Orden de preferencia para decidir cuál copia queda como tarjeta principal
// (la que trae más datos útiles gana: más fotos, contacto real del captador).
const PRIORIDAD_FUENTE_DUPLICADO = { 'Century 21': 1, 'RE/MAX': 2, BienInmuebles: 3, 'Mobiliario App': 4, CapitalCorp: 5, 'Alfa Bolivia': 6 };

// Agrupa por precio EXACTO antes de comparar — con miles de avisos, comparar
// cada par sería O(n²) sobre toda la lista; como esMismoInmueble siempre
// exige precio idéntico, alcanza con comparar dentro de cada bolsa de mismo
// precio (en la práctica, casi siempre de 1-3 avisos), no contra todo.
function fusionarDuplicados(items) {
  const porPrecio = new Map();
  for (const it of items) {
    if (it.precio == null) continue; // sin precio no puede fusionarse (esMismoInmueble ya lo exige)
    if (!porPrecio.has(it.precio)) porPrecio.set(it.precio, []);
    porPrecio.get(it.precio).push(it);
  }

  // Cada item que termina en un grupo (real, de 2+) apunta al mismo array
  // `grupo` — el primero de ese array (por PRIORIDAD_FUENTE_DUPLICADO) es el
  // que va a quedar como tarjeta principal.
  const grupoDe = new Map();
  for (const bolsa of porPrecio.values()) {
    if (bolsa.length < 2) continue;
    const usados = new Set();
    for (let i = 0; i < bolsa.length; i++) {
      if (usados.has(i)) continue;
      const grupo = [bolsa[i]];
      for (let j = i + 1; j < bolsa.length; j++) {
        if (usados.has(j)) continue;
        if (esMismoInmueble(bolsa[i], bolsa[j])) {
          grupo.push(bolsa[j]);
          usados.add(j);
        }
      }
      if (grupo.length > 1) {
        grupo.sort((x, y) => (PRIORIDAD_FUENTE_DUPLICADO[x.fuente] ?? 9) - (PRIORIDAD_FUENTE_DUPLICADO[y.fuente] ?? 9));
        for (const it of grupo) grupoDe.set(it, grupo);
      }
    }
  }

  const resultado = [];
  for (const it of items) {
    const grupo = grupoDe.get(it);
    if (!grupo) {
      resultado.push(it);
      continue;
    }
    if (it !== grupo[0]) continue; // no es la copia principal del grupo — la representa grupo[0]
    const copia = { ...it };
    copia.tambienEn = grupo.slice(1).map((d) => ({ fuente: d.fuente, link: d.link }));
    resultado.push(copia);
  }
  return resultado;
}

// ---------- Búsqueda combinada ----------

// Caché en memoria (se pierde si el proceso reinicia, no hace falta que
// sea más persistente que eso) del resultado crudo por tipo+operación,
// compartida entre todos los agentes. Ver el porqué junto a donde se usa,
// más abajo en buscarTodo.
const CACHE_BUSQUEDA_TTL_MS = 5 * 60 * 1000; // 5 minutos
const cacheBusquedaCruda = new Map();

async function buscarTodo(req) {
  const zonas = parseZonas(req.zona);
  const { precioMinUsd, precioMaxUsd, tc, moneda } = convertirPresupuesto(req);
  const destacar = (req.palabras || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Excluir: lo que el cliente explícitamente NO quiere (ej. "fuera de condominio").
  // A diferencia de "palabras" (que solo ordena), esto SÍ descarta avisos.
  const excluir = (req.excluir || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // matcheaPropiedad recalcula esto mismo por su cuenta para el filtrado
  // real — acá solo hace falta el número para informarlo en el objeto de
  // retorno (ver más abajo), ya no para pedirle un rango a RE/MAX.
  const MARGEN_PRECIO = 0.12;
  const antiguedadMaxDias = req.antiguedadMaxDias ? Number(req.antiguedadMaxDias) : null;

  // Antes un fallo de cualquier fuente (ej. un bloqueo anti-bot) se tragaba
  // en silencio con `.catch(() => [])` — la búsqueda mostraba menos avisos
  // sin decir por qué, y eso es exactamente lo que hacía sentir la app poco
  // confiable. Ahora se guarda el motivo real de cada fuente y se manda al
  // frontend, para que el agente vea "BienInmuebles: no disponible ahora
  // mismo" en vez de asumir en silencio que ya buscó en todos lados.
  const estadoFuentes = {};
  async function fetchConEstado(nombre, promesa) {
    try {
      const items = await promesa;
      estadoFuentes[nombre] = { ok: true };
      return items;
    } catch (e) {
      estadoFuentes[nombre] = { ok: false, motivo: e.message || 'Error desconocido' };
      return [];
    }
  }

  // Caché en memoria del RESULTADO CRUDO (sin filtrar por zona/precio/etc,
  // eso se hace siempre fresco más abajo con matcheaPropiedad) por
  // tipo+operación — compartida entre TODOS los agentes, no por sesión.
  // Agregada 2026-08-10 porque una búsqueda en una categoría grande (ej.
  // terreno, 1200+ avisos de C21) tardaba hasta 90s pegándole a los 4
  // portales desde cero cada vez, aunque dos agentes buscaran casi lo mismo
  // con solo la zona o el presupuesto distintos. RE/MAX dejó de pedir el
  // rango de precio en el request (antes lo hacía para traer menos avisos)
  // así el crudo cacheado sirve para cualquier presupuesto, no solo el de
  // la primera búsqueda que lo generó — el recorte por precio lo sigue
  // haciendo matcheaPropiedad, igual que con las otras 3 fuentes.
  const claveCacheBusqueda = `${req.tipo}|${req.operacion}`;
  const cacheado = cacheBusquedaCruda.get(claveCacheBusqueda);
  let c21, remax, bien, mobiliario, capitalcorp, alfabolivia;
  if (cacheado && Date.now() - cacheado.timestamp < CACHE_BUSQUEDA_TTL_MS) {
    ({ c21, remax, bien, mobiliario, capitalcorp, alfabolivia } = cacheado);
    Object.assign(estadoFuentes, cacheado.estadoFuentes);
  } else {
    [c21, remax, bien, mobiliario, capitalcorp, alfabolivia] = await Promise.all([
      fetchConEstado('Century 21', fetchC21(req)),
      fetchConEstado('RE/MAX', fetchRemax(req)),
      fetchConEstado('BienInmuebles', fetchBienInmuebles(req, tc)),
      fetchConEstado('Mobiliario App', fetchMobiliario(req, tc)),
      fetchConEstado('CapitalCorp', fetchCapitalCorp(req)),
      fetchConEstado('Alfa Bolivia', fetchAlfaBolivia(req, tc)),
    ]);
    // Solo se cachea si las 6 fuentes respondieron bien — un resultado
    // parcial por un fallo puntual de un portal no debe quedar pegado 5
    // minutos para todos los demás agentes que busquen lo mismo.
    if (Object.values(estadoFuentes).every((e) => e.ok)) {
      cacheBusquedaCruda.set(claveCacheBusqueda, { timestamp: Date.now(), c21, remax, bien, mobiliario, capitalcorp, alfabolivia, estadoFuentes: { ...estadoFuentes } });
    }
  }

  // Clonado (no solo el array, cada item) porque más abajo se mutan campos
  // por request (avisoPrecio, nivel, cercaPresupuesto, destaca) — si el
  // crudo viene del caché, esos objetos son compartidos entre CUALQUIER
  // búsqueda que caiga en la misma clave (mismo tipo+operación) durante los
  // 5 minutos de vigencia; sin clonar, dos agentes buscando con distinto
  // precio/zona se pisarían esos campos entre sí.
  let items = [...c21, ...remax, ...bien, ...mobiliario, ...capitalcorp, ...alfabolivia].map((i) => ({ ...i }));

  // Aviso de precio inconsistente: cuando el título/descripción del propio
  // aviso menciona un precio bien distinto al campo estructurado del portal
  // (el agente que publicó escribió mal uno de los dos). Nunca se "corrige"
  // solo — se marca para que el agente que usa la app decida cuál es el real.
  for (const i of items) {
    const otroPrecio = detectarPrecioInconsistente(`${i.titulo} ${i.descripcion}`, i.precio);
    if (otroPrecio) {
      i.avisoPrecio = `El texto del aviso menciona US$ ${otroPrecio.toLocaleString('es-BO')}, distinto al precio informado (US$ ${i.precio.toLocaleString('es-BO')}) — verificar con el portal.`;
    }
  }

  const porFuenteBruto = {
    'Century 21': c21.length,
    'RE/MAX': remax.length,
    BienInmuebles: bien.length,
    'Mobiliario App': mobiliario.length,
    CapitalCorp: capitalcorp.length,
    'Alfa Bolivia': alfabolivia.length,
  };

  // El nivel se asigna ACÁ (no dentro de los normalizadores normalizarC21/
  // Remax/BienInmuebles/Mobiliario) porque es relativo a este ACM puntual,
  // no una propiedad fija del aviso — todo lo scrapeado entra como B. Los
  // comparables manuales (más abajo) llegan con su propio nivel A/C.
  for (const i of items) i.nivel = 'B';

  // Filtrado completo (zona, precio+margen, dormitorios/baños, m², antigüedad,
  // excluir, palabras+filtroEstricto) — misma lógica de siempre, ahora en
  // matcheaPropiedad para poder reusarla comparando 1 sola propiedad nueva
  // contra requerimientos guardados (ver sincronizarRequerimientosGHL y el
  // enganche en sincronizarMobiliario).
  items = items.filter((i) => matcheaPropiedad(i, req));
  items = fusionarDuplicados(items);
  items.sort(
    (a, b) =>
      Number(b.destaca) - Number(a.destaca) ||
      Number(a.cercaPresupuesto) - Number(b.cercaPresupuesto) ||
      (a.precio ?? 1e12) - (b.precio ?? 1e12)
  );

  const porFuente = { 'Century 21': 0, 'RE/MAX': 0, BienInmuebles: 0, 'Mobiliario App': 0, CapitalCorp: 0, 'Alfa Bolivia': 0 };
  for (const i of items) porFuente[i.fuente] = (porFuente[i.fuente] || 0) + 1;
  const cantidadCerca = items.filter((i) => i.cercaPresupuesto).length;

  // Sujeto (punto medio de los rangos m² pedidos) y comparables manuales
  // (cierres reales u otra referencia cargados a mano) — solo alimentan el
  // ACM, nunca aparecen en `listados` (no son avisos reales de portal).
  const sujeto = calcularSujeto(req);
  const comparablesManuales = parsearComparablesManuales(req.comparablesManuales, req.tipo);

  return {
    listados: items,
    porFuente,
    porFuenteBruto,
    estadoFuentes,
    zonas,
    tc,
    moneda,
    precioMinUsd,
    precioMaxUsd,
    margenPrecio: MARGEN_PRECIO,
    cantidadCerca,
    destacar,
    excluir,
    antiguedadMaxDias,
    analisisMercado: calcularEstadisticasMercado([...items, ...comparablesManuales], req.tipo, sujeto),
  };
}

// ---------- Análisis Comparativo de Mercado (ACM) ----------
// Estadísticas puras (sin IA, sin costo) sobre los mismos comparables que ya
// trae la búsqueda — mediana de precio y de precio/m² son más confiables que
// el promedio acá porque un par de avisos con error de tipeo o outliers de
// lujo no deberían mover tanto la referencia.

function mediana(numsOrdenados) {
  const n = numsOrdenados.length;
  const mitad = Math.floor(n / 2);
  const valor = n % 2 !== 0 ? numsOrdenados[mitad] : (numsOrdenados[mitad - 1] + numsOrdenados[mitad]) / 2;
  return Math.round(valor);
}

// Pondera cada comparable en vez de tratarlos todos igual: nivel de origen
// del dato (A=cierre real cargado a mano, B=scrapeado, C=referencia informal
// cargada a mano), completitud de la fuente, cuán parecido es en tamaño al
// "sujeto" (punto medio del rango m² pedido en el form) y recencia (solo si
// se conoce la fecha — su ausencia nunca penaliza). Separa "cálculo" (acá,
// determinístico) de "redacción" (la IA en generarACM, más abajo) — el
// número que ve el agente no depende de qué tan bien redactó el modelo esa
// tanda.
const PESO_NIVEL = { A: 3, B: 1, C: 0.5 };
const PESO_FUENTE = { 'Century 21': 1.15, 'RE/MAX': 1.15, BienInmuebles: 0.9, 'Mobiliario App': 0.9, CapitalCorp: 0.9, 'Alfa Bolivia': 0.9 };
const PESO_OUTLIER_B = 0.25; // a un B marcado outlier no se lo excluye, se le baja el peso a esto
const UMBRAL_OUTLIER = 0.25; // desviación >25% de la mediana (solo-B, o de su cuartil en terreno) = outlier
const TOPE_PESO_FRACCION = 0.15; // ningún comparable puede aportar más del 15% del peso total

// Filtro de cordura — preprocesamiento, DISTINTO del chequeo de outlier de
// abajo (que compara contra el mercado). Esto descarta errores de tipeo de
// origen antes de que entren a cualquier cálculo, mismo criterio que ya usa
// normalizarC21 con su umbral de precio. Ej. real encontrado: un aviso de
// Century 21 con m2Construccion=1.432 (typo, falta un dígito) que disparaba
// un precio/m² de 698.324 — ni el chequeo de outlier de más abajo alcanza a
// neutralizar un dato así de roto, tiene que quedar afuera antes.
//
// Dos chequeos independientes:
// 1) Cordura de TAMAÑO — aplica a todos los tipos.
// 2) Cordura de PRECIO/M² con techo absoluto — SOLO para casa/depto/oficina/
//    local. En terreno el rango legítimo de USD/m² abarca 3 órdenes de
//    magnitud (lote urbano premium vs. extensión rural): un techo absoluto
//    no puede distinguir "caro real" de "typo" ahí, así que el único filtro
//    de precio para terreno es la segmentación por cuartiles + outlier de
//    más abajo, que compara cada lote contra otros de tamaño similar.
const M2_CONSTRUCCION_MIN = 15;
const M2_TERRENO_MIN = 10;
const PRECIO_M2_MIN = 50;
const PRECIO_M2_MAX = 10000;

function esComparableSano(item, campoM2) {
  const m2 = item[campoM2];
  if (!(m2 > 0)) return false;
  if (campoM2 === 'm2Construccion') {
    if (m2 < M2_CONSTRUCCION_MIN) return false;
    const precioM2 = item.precio / m2;
    if (precioM2 < PRECIO_M2_MIN || precioM2 > PRECIO_M2_MAX) return false;
  } else if (campoM2 === 'm2Terreno') {
    if (m2 < M2_TERRENO_MIN) return false;
  }
  return true;
}

function factorRecencia(fecha) {
  if (!fecha) return 1; // sin fecha = neutral, nunca se penaliza la ausencia del dato
  const dias = (Date.now() - new Date(fecha).getTime()) / 86400000;
  if (!Number.isFinite(dias) || dias < 0) return 1;
  if (dias <= 30) return 1.1;
  if (dias <= 90) return 1;
  if (dias <= 180) return 0.9;
  return 0.8;
}

// Punto medio del rango m² pedido en el form — no hay ficha de una única
// propiedad "sujeto", solo mín/máx, así que se usa el promedio de los dos (o
// el que esté definido si el otro quedó vacío).
function calcularSujeto(req) {
  const puntoMedio = (min, max) => {
    const mn = parsePrecio(min);
    const mx = parsePrecio(max);
    if (mn != null && mx != null) return (mn + mx) / 2;
    return mn ?? mx ?? null;
  };
  return {
    m2Terreno: puntoMedio(req.m2TerrenoMin, req.m2TerrenoMax),
    m2Construccion: puntoMedio(req.m2ConstruccionMin, req.m2ConstruccionMax),
  };
}

function calcularEstadisticasMercado(items, tipo, sujeto) {
  const conPrecio = items.filter((i) => i.precio != null);
  if (!conPrecio.length) return null;
  const precios = conPrecio.map((i) => i.precio).sort((a, b) => a - b);

  // Terreno (y los tipos tipo-terreno: terreno-comercial/rural/rancho/
  // agrícola/ganadera) se compara por precio/m² de terreno; el resto por
  // precio/m² construido. `esComparableSano` es el filtro de cordura — corre
  // ACÁ, antes de cualquier otra cosa, y es independiente del chequeo de
  // outlier estadístico de más abajo.
  const campoM2 = TIPOS_TERRENO.has(tipo) ? 'm2Terreno' : 'm2Construccion';
  const conM2 = conPrecio.filter((i) => esComparableSano(i, campoM2));
  let precioM2Promedio = null;
  let precioM2Mediana = null;
  let precioM2Ponderado = null;
  const comparablesDetalle = [];

  if (conM2.length) {
    const conRatio = conM2.map((i) => ({ item: i, precioM2: i.precio / i[campoM2] }));
    const preciosM2Ordenados = conRatio.map((c) => c.precioM2).sort((a, b) => a - b);
    precioM2Promedio = Math.round(preciosM2Ordenados.reduce((s, p) => s + p, 0) / preciosM2Ordenados.length);
    precioM2Mediana = mediana(preciosM2Ordenados);

    // Outliers: SOLO se detectan (y solo afectan el peso de) comparables
    // Nivel B — la mediana de referencia para detectarlos también se calcula
    // solo con B, para no contaminarla con cierres reales (A) ni referencias
    // informales (C).
    const soloB = conRatio.filter((c) => (c.item.nivel || 'B') === 'B');

    // En terreno, la mediana de referencia se calcula POR CUARTIL de tamaño
    // (m2Terreno) en vez de global — un lote urbano chico y un terreno rural
    // grande no son la misma población de precio/m², aunque compartan la
    // misma zona de texto libre. Con pocos B (<4) no alcanza para 4 grupos
    // con sentido: se usa la mediana global como respaldo.
    let medianaParaItem;
    if (TIPOS_TERRENO.has(tipo) && soloB.length >= 4) {
      const ordenadosPorTamano = [...soloB].sort((a, b) => a.item[campoM2] - b.item[campoM2]);
      const n = ordenadosPorTamano.length;
      const cuartilDe = (idx) => Math.min(3, Math.floor((idx / n) * 4));
      const cuartilPorItem = new Map();
      ordenadosPorTamano.forEach((c, idx) => cuartilPorItem.set(c.item, cuartilDe(idx)));
      const medianaPorCuartil = new Map();
      for (let q = 0; q < 4; q++) {
        const delCuartil = ordenadosPorTamano.filter((c, idx) => cuartilDe(idx) === q);
        if (delCuartil.length) medianaPorCuartil.set(q, mediana(delCuartil.map((c) => c.precioM2).sort((a, b) => a - b)));
      }
      medianaParaItem = (entry) => medianaPorCuartil.get(cuartilPorItem.get(entry.item)) ?? null;
    } else {
      const medianaGlobalB = soloB.length ? mediana(soloB.map((c) => c.precioM2).sort((a, b) => a - b)) : null;
      medianaParaItem = () => medianaGlobalB;
    }

    // Pase 1: peso "crudo" de cada comparable (nivel × fuente × tamaño ×
    // recencia × outlier), sin topar todavía.
    const crudos = conRatio.map(({ item, precioM2 }) => {
      const nivel = item.nivel || 'B';
      // Nivel A (cierre real) queda SIEMPRE fuera del chequeo de outlier —
      // esOutlier=false por definición sin importar cuánto se desvíe de la
      // mediana de portal: un cierre real no se penaliza por ser distinto al
      // mercado publicado. Mismo motivo excluye a C (no es dato de portal).
      const medianaRef = nivel === 'B' ? medianaParaItem({ item, precioM2 }) : null;
      const esOutlier = nivel === 'B' && medianaRef != null ? Math.abs(precioM2 - medianaRef) / medianaRef > UMBRAL_OUTLIER : false;

      const deltaTam = sujeto?.[campoM2]
        ? Math.abs((item[campoM2] - sujeto[campoM2]) / sujeto[campoM2])
        : 0; // sin sujeto definido = neutral, no se penaliza
      const similitudTamano = 1 / (1 + deltaTam);

      const peso =
        (PESO_NIVEL[nivel] ?? PESO_NIVEL.B) *
        (PESO_FUENTE[item.fuente] ?? 1) *
        similitudTamano *
        factorRecencia(item.fecha) *
        (esOutlier ? PESO_OUTLIER_B : 1);

      return { item, precioM2, nivel, esOutlier, peso };
    });

    // Pase 2: tope de peso por comparable — red de seguridad aparte del
    // chequeo de outlier de arriba: ningún comparable puede aportar más del
    // 15% del peso total, pase o no el filtro de cordura y el chequeo de
    // outlier. Cálculo de una sola pasada sobre el total sin topear (no
    // iterativo — alcanza para una red de seguridad).
    const sumaPesoSinTope = crudos.reduce((s, c) => s + c.peso, 0);
    const topePeso = sumaPesoSinTope * TOPE_PESO_FRACCION;

    let sumaPesoPrecio = 0;
    let sumaPeso = 0;
    for (const c of crudos) {
      const pesoFinal = topePeso > 0 ? Math.min(c.peso, topePeso) : c.peso;
      sumaPesoPrecio += c.precioM2 * pesoFinal;
      sumaPeso += pesoFinal;
      comparablesDetalle.push({
        link: c.item.link,
        fuente: c.item.fuente,
        nivel: c.nivel,
        precioM2: Math.round(c.precioM2),
        peso: Math.round(pesoFinal * 100) / 100,
        esOutlier: c.esOutlier,
        lat: c.item.lat ?? null,
        lon: c.item.lon ?? null,
        titulo: c.item.titulo || null,
        precio: c.item.precio ?? null,
      });
    }
    precioM2Ponderado = sumaPeso > 0 ? Math.round(sumaPesoPrecio / sumaPeso) : precioM2Mediana;
  }

  // ---------- confiabilidadGlobal ----------
  let score = 100;
  if (conM2.length < 3) score -= 40;
  const conFecha = conM2.filter((i) => i.fecha).length;
  if (conM2.length && conFecha / conM2.length < 0.3) score -= 15;
  if (comparablesDetalle.length) {
    const ratios = comparablesDetalle.map((c) => c.precioM2);
    const media = ratios.reduce((s, p) => s + p, 0) / ratios.length;
    const varianza = ratios.reduce((s, p) => s + (p - media) ** 2, 0) / ratios.length;
    const cv = media ? Math.sqrt(varianza) / media : 0;
    if (cv > 0.35) score -= 25;
  }
  const hayNivelA = comparablesDetalle.some((c) => c.nivel === 'A');
  score += hayNivelA ? 10 : -10;
  score = Math.max(0, Math.min(100, score));
  // Sin ningún comparable Nivel A (cierre real confirmado) el score nunca
  // puede llegar a "Alta", sin importar qué tan bien se vean los B — son
  // avisos publicados, no cierres. Tope explícito (no solo el -10 de arriba)
  // porque el resto del score puede seguir dando 90+ igual.
  if (!hayNivelA) score = Math.min(score, 79);
  const confiabilidadGlobal = {
    score,
    etiqueta: score >= 80 ? 'Alta' : score >= 50 ? 'Media' : 'Baja — tratar como referencia, no conclusión',
  };

  return {
    cantidadComparables: conPrecio.length,
    cantidadConM2: conM2.length,
    campoM2Usado: campoM2,
    precioPromedio: Math.round(precios.reduce((s, p) => s + p, 0) / precios.length),
    precioMediana: mediana(precios),
    precioMin: precios[0],
    precioMax: precios[precios.length - 1],
    precioM2Promedio,
    precioM2Mediana,
    precioM2Ponderado,
    confiabilidadGlobal,
    comparablesDetalle,
  };
}

// Comparables cargados a mano (cierres reales u otra referencia) — nivel A o
// C según lo que indique el agente. Si el JSON viene mal formado se ignora
// en silencio: nunca debe romper la búsqueda normal por esto.
function parsearComparablesManuales(json, tipo) {
  if (!json) return [];
  let lista;
  try {
    lista = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(lista)) return [];
  return lista
    .map((c) => ({
      fuente: 'Manual',
      nivel: c.nivel === 'A' ? 'A' : 'C',
      precio: parsePrecio(c.precio),
      m2Terreno: TIPOS_TERRENO.has(tipo) ? parsePrecio(c.m2) : null,
      m2Construccion: TIPOS_TERRENO.has(tipo) ? null : parsePrecio(c.m2),
      fecha: c.fecha || null,
      titulo: c.nota || 'Comparable manual',
      link: c.link || 'manual-' + Math.random().toString(36).slice(2),
      zona: '',
    }))
    .filter((c) => c.precio != null && (c.m2Terreno != null || c.m2Construccion != null));
}

// La IA ya recibe precioM2Ponderado, confiabilidadGlobal y comparablesDetalle
// CALCULADOS (ver calcularEstadisticasMercado) — su único trabajo es redactar
// sobre esos números, nunca recalcularlos ni reclasificar comparables.
const PROMPT_ACM =
  'Sos un tasador inmobiliario en Santa Cruz de la Sierra, Bolivia. Ya te paso las estadísticas y la ' +
  'clasificación de comparables YA CALCULADAS — tu único trabajo es REDACTAR, nunca recalcular ni ' +
  'reclasificar nada (no cambies niveles A/B/C, no inventes otro precio/m² de referencia, usá siempre ' +
  'precioM2Ponderado y confiabilidadGlobal tal como vienen). Devolvé SOLO este JSON, sin texto extra ni ' +
  'bloques de código: {"rangoSugerido":{"min":number,"max":number},"comentarioComparables":string,' +
  '"recomendacionPractica":string,"riesgoSiConfiabilidadBaja":string}. Reglas: LENGUAJE DE PRECIOS — nunca ' +
  'redactes un comparable Nivel B como si fuera un cierre/venta confirmada ("se vendió a", "se cerró en", ' +
  '"se vendieron en"); son avisos publicados, no transacciones, así que para B usá siempre "se está ' +
  'publicando/pidiendo actualmente en" o equivalente. Reservá el lenguaje de cierre ("se vendió a", "cerró ' +
  'en") EXCLUSIVAMENTE para comparables marcados nivel:"A" en comparablesDetalle — esto no es opcional ni a ' +
  'tu criterio, es la regla en cada corrida. rangoSugerido en USD, centrado en precioM2Ponderado × el m² ' +
  'del sujeto, con un ancho que dependa de la dispersión (más ancho si confiabilidadGlobal.score es bajo); ' +
  'comentarioComparables menciona 2-3 comparables específicos de comparablesDetalle (por link o descripción ' +
  'breve) y por qué pesan lo que pesan (nivel, outlier, similitud de tamaño), respetando el lenguaje de ' +
  'precios de arriba; recomendacionPractica es una frase práctica (precio de publicación sugerido o qué ' +
  'confirmar); riesgoSiConfiabilidadBaja: si confiabilidadGlobal.etiqueta es "Alta", dejá "" — si no, una ' +
  'frase explícita de qué tan poco confiable es el número y por qué (pocos comparables, sin cierres reales, ' +
  'dispersión alta, etc., según corresponda). Sin emojis, español, tono directo.';

const SCHEMA_ACM = {
  type: 'object',
  properties: {
    rangoSugerido: {
      type: 'object',
      properties: { min: { type: 'number' }, max: { type: 'number' } },
      required: ['min', 'max'],
      additionalProperties: false,
    },
    comentarioComparables: { type: 'string' },
    recomendacionPractica: { type: 'string' },
    riesgoSiConfiabilidadBaja: { type: 'string' },
  },
  required: ['rangoSugerido', 'comentarioComparables', 'recomendacionPractica', 'riesgoSiConfiabilidadBaja'],
  additionalProperties: false,
};

// Ya no manda el listado crudo de comparables (antes: contextoACM) — manda
// las stats + la clasificación tal como las calculó calcularEstadisticasMercado,
// para que la IA redacte sobre eso sin poder "corregir" el cálculo por su cuenta.
async function generarACM(req, stats) {
  if (!stats) return null;
  const user =
    `Criterios buscados (sujeto):\n${JSON.stringify(req)}\n\n` +
    `Estadísticas ya calculadas:\n${JSON.stringify(stats)}`;
  const proveedor = estadoIA().proveedor;
  const text =
    proveedor === 'gemini'
      ? await llamarGemini(PROMPT_ACM, user, true)
      : await llamarClaude(PROMPT_ACM, user, SCHEMA_ACM);
  try {
    return JSON.parse(text);
  } catch {
    // Degradado: si la IA no devolvió JSON válido, no se rompe la respuesta —
    // se muestra el texto crudo donde iría el comentario de comparables.
    return { rangoSugerido: null, comentarioComparables: text, recomendacionPractica: '', riesgoSiConfiabilidadBaja: '' };
  }
}

// ---------- Capa de IA (opcional) ----------
// Dos proveedores posibles, elegidos automáticamente según qué key haya en
// .env: GEMINI_API_KEY (GRATIS — cuota gratuita de Google AI Studio, sin
// tarjeta) tiene prioridad; si no está, ANTHROPIC_API_KEY (Claude, de pago)
// como alternativa de mejor calidad. Sin ninguna de las dos, la app funciona
// igual con el intérprete local por reglas (interpretarDictado en el frontend).

const AI_MODEL = process.env.AI_MODEL || 'claude-opus-4-8';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

function estadoIA() {
  if (process.env.GEMINI_API_KEY) {
    return { disponible: true, proveedor: 'gemini', modelo: GEMINI_MODEL, gratis: true, motivo: '' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      require.resolve('@anthropic-ai/sdk');
    } catch {
      return { disponible: false, motivo: 'Falta instalar el SDK: correr "npm install"' };
    }
    return { disponible: true, proveedor: 'claude', modelo: AI_MODEL, gratis: false, motivo: '' };
  }
  return {
    disponible: false,
    motivo: 'Falta una API key en el archivo .env (GEMINI_API_KEY gratis, o ANTHROPIC_API_KEY de pago)',
  };
}

function iaDisponible() {
  return estadoIA().disponible;
}

let _clienteIA = null;
function clienteIA() {
  if (_clienteIA) return _clienteIA;
  const Anthropic = require('@anthropic-ai/sdk');
  _clienteIA = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _clienteIA;
}

async function llamarClaude(system, user, schema) {
  const req = {
    model: AI_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (schema) req.output_config = { format: { type: 'json_schema', schema } };
  const resp = await clienteIA().messages.create(req);
  return resp.content.find((b) => b.type === 'text')?.text || '';
}

// API REST de Google Gemini (generativelanguage.googleapis.com) — sin SDK,
// un fetch normal, así se mantiene la app sin dependencias obligatorias.
async function llamarGemini(system, user, comoJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: comoJson ? { responseMimeType: 'application/json', temperature: 0.2 } : { temperature: 0.3 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ---------- Extracción en tiempo real (Agente de IA de Ingrid) ----------
// Corre en paralelo al bot conversacional de GHL, no en vez de él. El bot de
// GHL a veces "dice" que va a guardar un dato o derivar a un humano pero no
// ejecuta la acción en el mismo turno (límite real de la plataforma,
// confirmado con muchos casos reales) — y el 2026-08-11 se confirmó además
// que el bot puede MEZCLAR información de una propiedad que nunca se
// mencionó en esa conversación puntual. Esto lee el historial real de la
// conversación (nunca inventa) y corrige los campos casi al instante, en vez
// de esperar el barrido de 30 min (ingrid-notificacion-blindaje, que sigue
// existiendo como red de seguridad). Reusa el mismo Gemini gratuito que ya
// usa el resto de la app.

// IDs de campos y ubicación — hardcodeado a la cuenta real de Ingrid por
// ahora (único cliente en producción con esto activo). Para el segundo
// cliente, esto pasa a un mapa por locationId en vez de constantes sueltas.
const CAMPO_PROPIEDAD_INTERES = 'UtK3kfrpt91CRbTJIowg';
const CAMPO_MOTIVO_HANDOFF = 'UGHW5AZystxPLaLag0Qz';
const FALLBACK_MOTIVO_GENERICO = 'Consulta durante la conversación — revisar chat para más detalle';

const PROMPT_EXTRACCION_TIEMPO_REAL =
  'Sos un extractor de datos para conversaciones reales de WhatsApp de un agente inmobiliario en Santa Cruz de la Sierra, Bolivia. ' +
  'Te paso el historial reciente de UNA conversación. Tu único trabajo es leer los mensajes tal cual están y devolver JSON con lo que ' +
  'realmente se dijo — NUNCA inventes ni asumas nada que no esté escrito. ' +
  'Devolvé EXACTAMENTE estas claves: ' +
  'propiedad (string): el nombre de la propiedad específica que el LEAD preguntó o confirmó, tal como aparece en la conversación. ' +
  '"" si no hay ninguna clara, o si el lead mencionó más de una sin definirse. ' +
  'motivo (string): en una frase corta y concreta, qué necesita realmente el lead que amerite atención humana (precio especial, ' +
  'financiamiento, hablar con Ingrid, no encontró lo que busca, requerimiento distinto, otro agente coordinando, etc.). "" si no aplica. ' +
  'necesitaHumano (boolean): true si de la conversación se desprende que el lead necesita o pidió atención de una persona real. ' +
  'confusionDetectada (boolean): true SOLO si alguna respuesta del BOT (nunca del lead) menciona una propiedad, precio o dato que ' +
  'nunca fue mencionado ni preguntado por el lead en ESTA misma conversación — es decir, el bot mezcló info de otra conversación o inventó. ' +
  'detalleConfusion (string): si confusionDetectada=true, citá textual la frase del bot que no corresponde. "" si no aplica. ' +
  'Devolvé SOLO el JSON, sin texto extra ni bloques de código.';

async function fetchMensajesGHL(location, conversationId, limite) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=${limite || 20}`, {
    headers: { Authorization: 'Bearer ' + location.token, Version: '2021-07-28' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' trayendo mensajes');
  const data = await res.json();
  return data.messages?.messages || [];
}

async function fetchContactoGHL(location, contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { Authorization: 'Bearer ' + location.token, Version: '2021-07-28' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' trayendo contacto');
  const data = await res.json();
  return data.contact;
}

async function actualizarCamposContactoGHL(location, contactId, campos) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + location.token, Version: '2021-07-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: campos }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' actualizando contacto: ' + (await res.text()).slice(0, 300));
  return res.json();
}

// Corre la extracción para UN contacto/conversación puntual — llamado desde
// el webhook cada vez que llega un mensaje nuevo. Nunca manda mensajes al
// lead ni al agente; solo lee y corrige campos. Devuelve un resumen para loguear.
async function extraerYCorregirTiempoReal(location, contactId, conversationId) {
  const [contacto, mensajes] = await Promise.all([
    fetchContactoGHL(location, contactId),
    fetchMensajesGHL(location, conversationId, 20),
  ]);

  const transcripcion = mensajes
    .filter((m) => m.messageType === 'TYPE_WHATSAPP')
    .reverse()
    .map((m) => `[${m.direction === 'inbound' ? 'LEAD' : 'BOT'}] ${m.body || '(mensaje sin texto — audio/imagen)'}`)
    .join('\n');

  if (!transcripcion.trim()) return { sinCambios: true, motivo: 'sin mensajes de texto para analizar' };

  let extraido;
  try {
    const respuesta = await llamarGemini(PROMPT_EXTRACCION_TIEMPO_REAL, transcripcion, true);
    extraido = JSON.parse(respuesta);
  } catch (e) {
    return { error: 'Fallo la extracción con Gemini: ' + e.message };
  }

  // Por cliente, con el ID de Ingrid como respaldo — así un cliente nuevo
  // solo necesita cargar sus propios IDs de campo (ver POST .../ghl) sin
  // tocar código.
  const campoPropiedad = location.propiedadInteresFieldId || CAMPO_PROPIEDAD_INTERES;
  const campoMotivo = location.motivoHandoffFieldId || CAMPO_MOTIVO_HANDOFF;

  const camposActuales = contacto.customFields || [];
  const propiedadActual = camposActuales.find((c) => c.id === campoPropiedad)?.value || '';
  const motivoActual = camposActuales.find((c) => c.id === campoMotivo)?.value || '';

  const camposAActualizar = [];
  let propiedadCorregida = null;
  let motivoCorregido = null;

  // Solo pisa la Propiedad Interes si hoy está vacía o en "sin especificar" —
  // nunca sobreescribe algo que ya quedó bien guardado por el propio bot.
  if (extraido.propiedad && (!propiedadActual || /sin especificar/i.test(propiedadActual))) {
    camposAActualizar.push({ id: campoPropiedad, field_value: extraido.propiedad });
    propiedadCorregida = extraido.propiedad;
  }
  // Solo pisa el Motivo Handoff si hoy está vacío o es el texto genérico de siempre.
  if (extraido.motivo && (!motivoActual || motivoActual.trim() === FALLBACK_MOTIVO_GENERICO)) {
    camposAActualizar.push({ id: campoMotivo, field_value: extraido.motivo });
    motivoCorregido = extraido.motivo;
  }

  if (camposAActualizar.length) {
    await actualizarCamposContactoGHL(location, contactId, camposAActualizar);
  }

  return {
    propiedadCorregida,
    motivoCorregido,
    necesitaHumano: !!extraido.necesitaHumano,
    confusionDetectada: !!extraido.confusionDetectada,
    detalleConfusion: extraido.detalleConfusion || '',
  };
}

const PROMPT_INTERPRETAR =
  'Sos el asistente de un agente inmobiliario en Santa Cruz de la Sierra, Bolivia. Recibís pedidos ' +
  'dictados por voz, a veces desordenados o con palabras repetidas — interpretá la intención real, ' +
  'no el texto literal. Extraé los criterios de búsqueda y devolvelos en JSON, con EXACTAMENTE estas ' +
  'claves de tipo string (todas presentes, "" si no aplica): cliente, operacion (venta|alquiler), ' +
  'tipo (casa|departamento|terreno|local|oficina|quinta|terreno-comercial|edificio|deposito|tinglado|' +
  'rural|rancho|agricolas|ganaderas|cochera|hotel|colegio|proyecto), zona, moneda (usd|bob), precioMin, precioMax, ' +
  'dormitorios, banos, m2TerrenoMin, m2TerrenoMax, m2ConstruccionMin, m2ConstruccionMax, palabras, ' +
  'excluir, antiguedadMaxDias, dudas. Reglas: ' +
  'zona puede ser una lista separada por comas (ej. "norte, este, Doble Vía a La Guardia"); ' +
  'si mencionan bolivianos o "Bs", moneda="bob", si no, "usd"; ' +
  'precioMin/precioMax solo el número entero sin puntos ni comas; ' +
  'dormitorios solo el número mínimo; banos solo el número mínimo; ' +
  'm2TerrenoMin/Max = superficie de terreno en m² (ej. "terreno de 300 a 500 m2"); ' +
  'm2ConstruccionMin/Max = superficie construida en m² (ej. "construcción mínima 150 m2"); solo números; ' +
  'palabras = características que el aviso DEBE mencionar (avenida, esquina, piscina, amoblado, garaje…), separadas por comas; ' +
  'excluir = características que el cliente explícitamente NO quiere — prestá mucha atención a negaciones como ' +
  '"fuera de", "sin", "no quiero", "que no tenga": "fuera de condominio" va en excluir="condominio", NUNCA en palabras; ' +
  'antiguedadMaxDias = si dice "reciente", "actualizado", "no antiguo" sin número, poné "90"; si dice "últimos N meses", poné N*30; ' +
  'dudas = si el pedido tiene datos contradictorios (ej. dos presupuestos distintos) o es ambiguo, explicá acá en ' +
  'una frase qué se debería confirmar con el cliente; si no hay dudas, dejá "". ' +
  'Dejá "" en lo que no se mencione. Por defecto tipo="casa" y operacion="venta". ' +
  'Devolvé SOLO el JSON, sin texto extra ni bloques de código.';

const SCHEMA_INTERPRETAR = {
  type: 'object',
  properties: {
    cliente: { type: 'string' },
    operacion: { type: 'string', enum: ['venta', 'alquiler'] },
    tipo: {
      type: 'string',
      enum: [
        'casa', 'departamento', 'terreno', 'local', 'oficina',
        'quinta', 'terreno-comercial', 'edificio', 'deposito', 'tinglado',
        'rural', 'rancho', 'agricolas', 'ganaderas', 'cochera', 'hotel', 'colegio', 'proyecto',
      ],
    },
    zona: { type: 'string' },
    moneda: { type: 'string', enum: ['usd', 'bob'] },
    precioMin: { type: 'string' },
    precioMax: { type: 'string' },
    dormitorios: { type: 'string' },
    banos: { type: 'string' },
    m2TerrenoMin: { type: 'string' },
    m2TerrenoMax: { type: 'string' },
    m2ConstruccionMin: { type: 'string' },
    m2ConstruccionMax: { type: 'string' },
    palabras: { type: 'string' },
    excluir: { type: 'string' },
    antiguedadMaxDias: { type: 'string' },
    dudas: { type: 'string' },
  },
  required: ['cliente', 'operacion', 'tipo', 'zona', 'moneda', 'precioMin', 'precioMax', 'dormitorios', 'banos', 'm2TerrenoMin', 'm2TerrenoMax', 'm2ConstruccionMin', 'm2ConstruccionMax', 'palabras', 'excluir', 'antiguedadMaxDias', 'dudas'],
  additionalProperties: false,
};

// Captura rápida de captaciones que llegan por WhatsApp: el agente pega el
// texto del mensaje que le mandó OTRO agente ofreciéndole una propiedad, y
// esto lo convierte en los campos del formulario de inventario (categoría
// "otro") — mismo criterio que PROMPT_INTERPRETAR pero para una FICHA de
// propiedad (un precio puntual, no un rango), no un pedido de cliente.
const PROMPT_CAPTACION =
  'Sos el asistente de un agente inmobiliario en Santa Cruz de la Sierra, Bolivia. Te paso el texto de un ' +
  'mensaje de WhatsApp que le mandó OTRO agente ofreciéndole una propiedad (una captación). Extraé los ' +
  'datos en JSON con EXACTAMENTE estas claves (todas presentes; "" en las de texto y null en las ' +
  'numéricas si no aparecen): titulo (string corto y descriptivo — inventá uno breve si no hay), ' +
  'tipo (casa|departamento|terreno|local|oficina|quinta|terreno-comercial|edificio|deposito|tinglado|' +
  'rural|rancho|agricolas|ganaderas|cochera|hotel|colegio|proyecto), operacion (venta|alquiler), ' +
  'precio (número en USD sin símbolos ni puntos de miles — si está en bolivianos, convertilo a USD ' +
  'dividiendo por 6.96), zona (string), dormitorios (número), banos (número), m2Terreno (número), ' +
  'm2Construccion (número), descripcion (string corto con el resto de detalles relevantes del mensaje), ' +
  'captadorNombre (si el mensaje menciona o firma con el nombre de quién ofrece la propiedad, si no ""). ' +
  'Nunca inventes precio ni m² que no estén en el texto. Devolvé SOLO el JSON, sin texto extra.';

const SCHEMA_CAPTACION = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    tipo: {
      type: 'string',
      enum: [
        'casa', 'departamento', 'terreno', 'local', 'oficina',
        'quinta', 'terreno-comercial', 'edificio', 'deposito', 'tinglado',
        'rural', 'rancho', 'agricolas', 'ganaderas', 'cochera', 'hotel', 'colegio', 'proyecto',
      ],
    },
    operacion: { type: 'string', enum: ['venta', 'alquiler'] },
    precio: { type: ['number', 'null'] },
    zona: { type: 'string' },
    dormitorios: { type: ['number', 'null'] },
    banos: { type: ['number', 'null'] },
    m2Terreno: { type: ['number', 'null'] },
    m2Construccion: { type: ['number', 'null'] },
    descripcion: { type: 'string' },
    captadorNombre: { type: 'string' },
  },
  required: ['titulo', 'tipo', 'operacion', 'precio', 'zona', 'dormitorios', 'banos', 'm2Terreno', 'm2Construccion', 'descripcion', 'captadorNombre'],
  additionalProperties: false,
};

async function interpretarCaptacionConIA(texto) {
  const proveedor = estadoIA().proveedor;
  const text =
    proveedor === 'gemini'
      ? await llamarGemini(PROMPT_CAPTACION, texto, true)
      : await llamarClaude(PROMPT_CAPTACION, texto, SCHEMA_CAPTACION);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const PROMPT_RESUMIR =
  'Sos el asistente de un agente inmobiliario. Te paso el requerimiento de un cliente y las propiedades encontradas. ' +
  'Devolvé un resumen corto y concreto en español, máximo 4 líneas, sin emojis: cuántas cumplen, ' +
  'cuáles son las 2 o 3 mejores para este cliente y por qué (precio, zona, tamaño), y qué conviene hacer. Directo, al grano.';

function contextoResumen(listados) {
  return listados.slice(0, 15).map((i) => ({
    fuente: i.fuente,
    precio: i.precio,
    zona: i.zona,
    dormitorios: i.dormitorios,
    banos: i.banos,
    m2Terreno: i.m2Terreno,
    m2Construccion: i.m2Construccion,
    fecha: i.fecha,
    titulo: i.titulo,
    captador: i.asesor,
  }));
}

// Interpreta el pedido del cliente (texto o dictado) → campos del formulario
async function interpretarConIA(texto) {
  const proveedor = estadoIA().proveedor;
  const text =
    proveedor === 'gemini'
      ? await llamarGemini(PROMPT_INTERPRETAR, texto, true)
      : await llamarClaude(PROMPT_INTERPRETAR, texto, SCHEMA_INTERPRETAR);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Resume los resultados de forma concreta para el agente
async function resumirConIA(req, listados) {
  if (!listados.length) return null;
  const user = `Requerimiento del cliente:\n${JSON.stringify(req)}\n\nPropiedades encontradas:\n${JSON.stringify(contextoResumen(listados))}`;
  const proveedor = estadoIA().proveedor;
  return proveedor === 'gemini' ? await llamarGemini(PROMPT_RESUMIR, user, false) : await llamarClaude(PROMPT_RESUMIR, user, null);
}

// Chat de la vitrina pública: un colega agente pregunta en lenguaje natural
// por el inventario y la IA responde SOLO con lo que hay en esa lista — no
// tiene acceso a nada más (ni a otros agentes, ni a los portales).
const PROMPT_VITRINA =
  'Sos el asistente virtual de un agente inmobiliario en Santa Cruz de la Sierra, Bolivia. Un colega ' +
  'agente te escribe preguntando por el inventario disponible de este agente. Respondé SOLO en base a ' +
  'la lista de propiedades que te paso — nunca inventes datos, precios ni propiedades que no estén ahí. ' +
  'Si hay propiedades que calzan, listalas con título, precio y zona en un mensaje corto y amigable ' +
  '(texto plano, sin markdown). Si ninguna calza, decilo con claridad y mencioná qué otras categorías sí ' +
  'hay disponibles.';

async function preguntarInventarioConIA(pregunta, propiedades, nombreAgente) {
  const user = `Agente: ${nombreAgente}\n\nInventario disponible:\n${JSON.stringify(propiedades)}\n\nPregunta del colega: ${pregunta}`;
  const proveedor = estadoIA().proveedor;
  return proveedor === 'gemini' ? await llamarGemini(PROMPT_VITRINA, user, false) : await llamarClaude(PROMPT_VITRINA, user, null);
}

// Red entre agentes: un agente logueado pregunta si algún OTRO agente de la
// plataforma tiene algo que calce con lo que busca su cliente. El filtrado
// de "qué califica" ya lo hizo matcheaPropiedad (determinístico, mismo
// criterio de siempre) — acá la IA solo redacta la respuesta sobre
// resultados YA decididos, nunca decide ella sola qué es un match.
const PROMPT_RED =
  'Sos el asistente de un agente inmobiliario en Santa Cruz de la Sierra, Bolivia. Este agente te ' +
  'pregunta si algún OTRO agente de la plataforma tiene una propiedad que calce con lo que busca su ' +
  'cliente. Te paso una lista YA FILTRADA de propiedades que coinciden — tu trabajo es redactar una ' +
  'respuesta corta y clara (texto plano, sin markdown) diciendo qué agente tiene qué, con sus datos de ' +
  'contacto, para que lo pueda llamar. Nunca inventes datos que no estén en la lista.';

async function preguntarRedConIA(pregunta, matches) {
  const user = `Coincidencias encontradas en el inventario de otros agentes:\n${JSON.stringify(matches)}\n\nPregunta original: ${pregunta}`;
  const proveedor = estadoIA().proveedor;
  return proveedor === 'gemini' ? await llamarGemini(PROMPT_RED, user, false) : await llamarClaude(PROMPT_RED, user, null);
}

// ---------- Links directos (portales sin lectura automática) ----------

function linksExternos(req) {
  const q = [req.tipo, req.zona, 'santa cruz'].filter(Boolean).join(' ');
  const opTxt = req.operacion === 'alquiler' ? 'alquiler' : 'venta';
  return [
    {
      nombre: 'Bolivia Inmuebles',
      url: 'https://boliviainmuebles.com/',
    },
    {
      nombre: 'KW Bolivia',
      url: 'https://bolivia.kw.com/es-419/propiedades/?q=' + encodeURIComponent(q),
    },
    {
      nombre: 'Facebook Ads (anuncios activos)',
      url:
        'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BO&media_type=all&search_type=keyword_unordered&q=' +
        encodeURIComponent(q),
    },
    {
      nombre: 'Facebook Marketplace',
      url:
        'https://www.facebook.com/marketplace/santacruzdelasierra/search?query=' +
        encodeURIComponent([req.tipo, opTxt, req.zona].filter(Boolean).join(' ')),
    },
    {
      nombre: 'Grupos de Facebook',
      url: 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(q),
    },
    {
      nombre: 'Google (todos los portales)',
      url:
        'https://www.google.com/search?q=' +
        encodeURIComponent(`${req.tipo} en ${opTxt} ${req.zona || ''} santa cruz bolivia`),
    },
  ];
}

// ---------- Servidor HTTP ----------

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function leerBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b));
      } catch {
        resolve({});
      }
    });
  });
}

// Normaliza el body de un requerimiento (usado tanto al crear como al editar,
// así los dos caminos quedan siempre con las mismas reglas).
function camposRequerimiento(body) {
  return {
    cliente: body.cliente || 'Sin nombre',
    telefono: body.telefono || '',
    operacion: body.operacion === 'alquiler' ? 'alquiler' : 'venta',
    tipo: TIPOS.has(body.tipo) ? body.tipo : 'casa',
    zona: (body.zona || '').trim(),
    precioMin: body.precioMin || '',
    precioMax: body.precioMax || '',
    moneda: body.moneda === 'bob' ? 'bob' : 'usd',
    tc: body.tc || '',
    dormitorios: body.dormitorios || '',
    banos: body.banos || '',
    m2TerrenoMin: body.m2TerrenoMin || '',
    m2TerrenoMax: body.m2TerrenoMax || '',
    m2ConstruccionMin: body.m2ConstruccionMin || '',
    m2ConstruccionMax: body.m2ConstruccionMax || '',
    palabras: body.palabras || '',
    excluir: body.excluir || '',
    filtroEstricto: body.filtroEstricto === '1' ? '1' : '',
    antiguedadMaxDias: body.antiguedadMaxDias || '',
    notas: body.notas || '',
  };
}

// La lógica de cada pedido vive en una función aparte (en vez de directo
// adentro de http.createServer) para poder envolverla en un try/catch real
// más abajo — sin esto, un error inesperado en CUALQUIER pedido (de
// cualquier agente) tumba el proceso de Node ENTERO y desconecta a todos los
// demás que estén usando la app al mismo tiempo (comportamiento por defecto
// de Node 15+ ante una promesa rechazada sin atrapar). Importante ahora que
// varios agentes van a probarla en simultáneo.
async function manejarRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Webhook de extracción en tiempo real — lo llama un Workflow de GHL cada
  // vez que llega un mensaje nuevo en la cuenta de Ingrid (o cualquier otra
  // location que se sume después). Ver extraerYCorregirTiempoReal más arriba
  // para el porqué. Protegido por un secreto compartido (query param
  // `secret`, va en la URL del Webhook action del workflow) — no hay sesión
  // de usuario acá, así que el secreto es la única barrera.
  if (url.pathname === '/webhooks/ghl-mensaje' && req.method === 'POST') {
    const secretoEsperado = process.env.WEBHOOK_SECRET;
    if (!secretoEsperado || url.searchParams.get('secret') !== secretoEsperado) {
      return json(res, 401, { error: 'Secreto inválido o no configurado.' });
    }
    let body;
    try {
      body = await leerBody(req);
    } catch {
      return json(res, 400, { error: 'Body inválido.' });
    }
    // Flexible a propósito: el payload exacto que manda un Workflow de GHL
    // depende de cómo José Luis arme el paso de Webhook — se acepta
    // cualquiera de estos nombres de campo comunes.
    const contactId = body.contactId || body.contact_id || body.contact?.id;
    const locationId = body.locationId || body.location_id || body.location?.id || 'c2e5fSjLYJRVGbLREgps';
    let conversationId = body.conversationId || body.conversation_id;
    if (!contactId) return json(res, 400, { error: 'Falta contactId en el payload.' });

    const loc = leerLocationsGHL().find((l) => l.locationId === locationId);
    if (!loc) return json(res, 404, { error: 'No hay una cuenta de GHL configurada para ese locationId.' });

    // Responde YA (el workflow no necesita esperar el resultado) y sigue
    // procesando en segundo plano — así no se cuelga el paso del workflow
    // en GHL si Gemini tarda.
    json(res, 202, { ok: true, procesando: true });

    (async () => {
      try {
        if (!conversationId) {
          const busq = await fetch(
            `https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${locationId}`,
            { headers: { Authorization: 'Bearer ' + loc.token, Version: '2021-07-28' } }
          );
          const datosBusq = await busq.json();
          conversationId = datosBusq.conversations?.[0]?.id;
        }
        if (!conversationId) {
          console.error('Webhook tiempo real: no se encontró conversación para', contactId);
          return;
        }
        const resultado = await extraerYCorregirTiempoReal(loc, contactId, conversationId);
        console.log('Extracción tiempo real', contactId, '->', JSON.stringify(resultado));
        // Confusión de propiedades detectada — esto es nuevo y serio (el
        // bot mezclando datos de otra conversación), avisa por correo al
        // toque en vez de esperar cualquier barrido periódico.
        if (resultado.confusionDetectada) {
          const agentesLista = leerAgentes();
          const agenteDueño = agentesLista.find((a) => a.id === loc.agenteId);
          const correo = agenteDueño?.correoNotificaciones;
          if (correo) {
            const contactoIdNotif = await upsertContactoNotificacionesGHL(loc, { correo });
            await enviarEmailGHL(
              loc,
              contactoIdNotif,
              correo,
              '⚠️ El bot mezcló información de otra propiedad (tiempo real)',
              `<p>Contacto: ${contactId}</p><p>El bot dijo algo que no corresponde a esta conversación:</p><p><em>${escapeHtml(resultado.detalleConfusion)}</em></p>`,
              true
            );
          }
        }
      } catch (e) {
        console.error('Error en extracción de tiempo real para', contactId, ':', e.message);
      }
    })();
    return;
  }

  // Página pública de presentación de propiedades — la abre el CLIENTE
  // desde el link que le llega por WhatsApp, sin ninguna clave. Va antes de
  // cualquier autenticación a propósito. Muestra la marca/contacto del
  // agente, nunca del captador original (ver prepararRevisionCliente/aprobarEnvioCliente).
  const mPresentacion = url.pathname.match(/^\/p\/([^/]+)\/([^/]+)$/);
  if (mPresentacion && req.method === 'GET') {
    const [, agenteIdP, envioId] = mPresentacion;
    const envio = envioPorId(agenteIdP, envioId);
    const agenteP = leerAgentes().find((a) => a.id === agenteIdP);
    if (!envio || !agenteP) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>No encontrado</h1>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paginaPresentacionCliente(envio, agenteP));
  }

  // Página pública del reporte de zona (ver POST /api/reporte-zona) — mismo
  // criterio que /p/: sin login, protegida solo por el id de 16 bytes.
  const mReporteZona = url.pathname.match(/^\/reporte\/([^/]+)\/([^/]+)$/);
  if (mReporteZona && req.method === 'GET') {
    const [, agenteIdRZ, reporteId] = mReporteZona;
    const reporte = reporteZonaPorId(agenteIdRZ, reporteId);
    const agenteRZ = leerAgentes().find((a) => a.id === agenteIdRZ);
    if (!reporte || !agenteRZ) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>No encontrado</h1>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paginaReporteZona(reporte, agenteRZ));
  }

  // Página de revisión del AGENTE — mismo criterio de link no adivinable,
  // sin login, para poder abrirla en un toque desde el WhatsApp/correo.
  const mRevision = url.pathname.match(/^\/revisar\/([^/]+)\/([^/]+)$/);
  if (mRevision && req.method === 'GET') {
    const [, agenteIdR, envioId] = mRevision;
    const envio = envioPorId(agenteIdR, envioId);
    const agenteR = leerAgentes().find((a) => a.id === agenteIdR);
    if (!envio || !agenteR) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>No encontrado</h1>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paginaRevisionAgente(envio, agenteR));
  }

  // Acciones de aprobar/rechazar (llamadas por el JS de la página de
  // revisión) — también sin auth de apiKey, protegidas solo por el id no
  // adivinable, mismo criterio que las dos rutas de arriba.
  const mAprobar = url.pathname.match(/^\/api\/envios-clientes\/([^/]+)\/([^/]+)\/aprobar$/);
  if (mAprobar && req.method === 'POST') {
    const [, agenteIdA, envioId] = mAprobar;
    const registro = envioPorId(agenteIdA, envioId);
    const agenteA = leerAgentes().find((a) => a.id === agenteIdA);
    const loc = leerLocationsGHL().find((l) => l.agenteId === agenteIdA);
    if (!registro || !agenteA || !loc) return json(res, 404, { error: 'No encontrado.' });
    if (registro.estado && registro.estado !== 'pendiente') return json(res, 409, { error: 'Este envío ya fue procesado.' });
    try {
      const body = await leerBody(req);
      const resultado = await aprobarEnvioCliente(loc, agenteA, registro, body.excluidos || []);
      return json(res, 200, { ok: true, ...resultado });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  const mRechazar = url.pathname.match(/^\/api\/envios-clientes\/([^/]+)\/([^/]+)\/rechazar$/);
  if (mRechazar && req.method === 'POST') {
    const [, agenteIdX, envioId] = mRechazar;
    const ok = rechazarEnvioCliente(agenteIdX, envioId);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No existe ese envío.' });
  }

  const requiereAuth = modoMultiagente();
  const agente = autenticar(req);

  // Estado de sesión: lo consulta la interfaz para saber si hace falta pedir
  // una key y, si ya hay una válida, de qué agente se trata. Siempre responde,
  // incluso sin key, para poder mostrar la pantalla de acceso.
  if (url.pathname === '/api/whoami' && req.method === 'GET') {
    return json(res, 200, {
      requiereAuth,
      agente: agente
        ? {
            id: agente.id,
            nombre: agente.nombre,
            trial: estadoTrial(agente),
            telefonoContacto: agente.telefonoContacto || '',
            telefonoNotificaciones: agente.telefonoNotificaciones || '',
            correoNotificaciones: agente.correoNotificaciones || '',
            driveRaizUrl: agente.driveRaizUrl || '',
            inmobiliaria: agente.inmobiliaria || '',
            oficina: agente.oficina || '',
            fotoPerfil: agente.fotoPerfil || '',
          }
        : null,
    });
  }

  // Registro y login: exentos del chequeo de key de acá abajo — obviamente,
  // todavía no tienen una. Devuelven el apiKey de siempre (mismo mecanismo
  // de aislamiento por agente que ya existía) para que el frontend lo guarde
  // igual que si José Luis les hubiera pasado un link con key.
  if (url.pathname === '/api/registrar' && req.method === 'POST') {
    const body = await leerBody(req);
    try {
      const agenteNuevo = registrarAgente(body);
      return json(res, 200, { apiKey: agenteNuevo.apiKey, nombre: agenteNuevo.nombre });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await leerBody(req);
    try {
      const agenteLogueado = loginAgente(body);
      return json(res, 200, { apiKey: agenteLogueado.apiKey, nombre: agenteLogueado.nombre });
    } catch (e) {
      return json(res, 401, { error: e.message });
    }
  }

  // Panel de administración — todo /api/admin/* exige X-Admin-Key (distinta
  // de las apiKey de agente), sin excepción.
  if (url.pathname.startsWith('/api/admin/')) {
    if (!esAdmin(req)) return json(res, 403, { error: 'Clave de administrador inválida.' });

    // Crear un agente "por CLI" (sin email/password) directo desde el panel
    // — mismo esquema exacto que scripts/agentes.js, para no depender de
    // acceso por SSH/terminal al servidor donde corre la app.
    if (url.pathname === '/api/admin/agentes' && req.method === 'POST') {
      const body = await leerBody(req);
      const nombre = (body.nombre || '').trim();
      if (!nombre) return json(res, 400, { error: 'Falta el nombre.' });
      const lista = leerAgentes();
      const nuevo = {
        id: crypto.randomBytes(4).toString('hex'),
        nombre,
        apiKey: 'sof_' + crypto.randomBytes(24).toString('hex'),
        creado: new Date().toISOString(),
        activo: true,
      };
      lista.push(nuevo);
      guardarAgentes(lista);
      return json(res, 200, { id: nuevo.id, nombre: nuevo.nombre, apiKey: nuevo.apiKey });
    }

    // José Luis necesita poder recuperar el acceso de un agente (cliente que
    // olvidó su contraseña, o para conseguir su link directo) sin tener SSH
    // a producción — todo vía el panel admin, protegido por ADMIN_KEY.
    const mApiKey = url.pathname.match(/^\/api\/admin\/agentes\/([^/]+)\/apikey$/);
    if (mApiKey && req.method === 'GET') {
      const [, id] = mApiKey;
      const agente = leerAgentes().find((a) => a.id === id);
      if (!agente) return json(res, 404, { error: 'No existe ese agente.' });
      return json(res, 200, { id: agente.id, nombre: agente.nombre, apiKey: agente.apiKey });
    }

    const mResetPassword = url.pathname.match(/^\/api\/admin\/agentes\/([^/]+)\/reset-password$/);
    if (mResetPassword && req.method === 'POST') {
      const [, id] = mResetPassword;
      const body = await leerBody(req);
      if (!body.password || body.password.length < 6) {
        return json(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
      }
      const lista = leerAgentes();
      const idx = lista.findIndex((a) => a.id === id);
      if (idx === -1) return json(res, 404, { error: 'No existe ese agente.' });
      const { salt, hash } = hashPassword(body.password);
      lista[idx] = { ...lista[idx], passwordSalt: salt, passwordHash: hash };
      guardarAgentes(lista);
      return json(res, 200, { ok: true, email: lista[idx].email || null });
    }

    // Dispara el barrido de matches para UN agente ahora mismo, sin esperar
    // al ciclo automático de 12h — para demos, o para probar en vivo que un
    // requerimiento puntual encuentra opciones y manda el WhatsApp real.
    const mBarrido = url.pathname.match(/^\/api\/admin\/agentes\/([^/]+)\/barrido$/);
    if (mBarrido && req.method === 'POST') {
      const [, id] = mBarrido;
      const loc = leerLocationsGHL().find((l) => l.agenteId === id);
      if (!loc) return json(res, 404, { error: 'Ese agente no tiene GHL conectado (o no tiene requerimientoFieldId configurado).' });
      const agente = leerAgentes().find((a) => a.id === id);
      if (!agente) return json(res, 404, { error: 'No existe ese agente.' });
      try {
        const forzar = url.searchParams.get('forzar') === '1';
        const soloRequerimientoId = url.searchParams.get('requerimientoId') || undefined;
        const resumen = await barridoMatchesParaAgente(loc, agente, { forzar, soloRequerimientoId });
        return json(res, 200, resumen);
      } catch (e) {
        return json(res, 500, { error: 'Error corriendo el barrido: ' + e.message });
      }
    }

    if (url.pathname === '/api/admin/agentes' && req.method === 'GET') {
      const agentesConDatos = leerAgentes().map((a) => ({
        id: a.id,
        nombre: a.nombre,
        email: a.email || null,
        origen: a.email ? 'cuenta propia' : 'clave por CLI',
        creado: a.creado,
        activo: a.activo !== false,
        cantidadRequerimientos: leerRequerimientos(a.id).length,
        telefonoNotificaciones: a.telefonoNotificaciones || '',
        correoNotificaciones: a.correoNotificaciones || '',
        // No se manda el token acá (aunque este panel ya está protegido por
        // ADMIN_KEY) — con saber que está conectado alcanza para la tabla.
        ghlConectado: !!(a.ghlConfig && a.ghlConfig.locationId),
        ghlLocationId: a.ghlConfig?.locationId || null,
        trial: estadoTrial(a),
      }));
      agentesConDatos.sort((x, y) => new Date(y.creado) - new Date(x.creado));
      return json(res, 200, agentesConDatos);
    }

    // Conectar (o actualizar) la cuenta de GHL de un agente — José Luis la
    // carga una vez por cliente nuevo; queda guardada junto a ese agente,
    // aislada de los demás (mismo criterio que sus requerimientos propios).
    const mGhlConectar = url.pathname.match(/^\/api\/admin\/agentes\/([^/]+)\/ghl$/);
    if (mGhlConectar && req.method === 'POST') {
      const [, id] = mGhlConectar;
      const lista = leerAgentes();
      const agente = lista.find((a) => a.id === id);
      if (!agente) return json(res, 404, { error: 'No existe ese agente.' });
      const body = await leerBody(req);
      if (!body.locationId || !body.token || !body.requerimientoFieldId) {
        return json(res, 400, { error: 'Faltan locationId, token o requerimientoFieldId.' });
      }
      // Se mezcla con lo que ya había (no se reemplaza entero) — así una
      // actualización posterior (ej. rotar el token) no borra los campos
      // opcionales que se hayan cargado antes.
      agente.ghlConfig = {
        ...(agente.ghlConfig || {}),
        locationId: body.locationId.trim(),
        token: body.token.trim(),
        requerimientoFieldId: body.requerimientoFieldId.trim(),
        // Opcionales — solo hacen falta si este cliente también usa la
        // extracción en tiempo real (ver extraerYCorregirTiempoReal). Sin
        // esto, esa función cae al ID de Ingrid por compatibilidad, así que
        // para un cliente nuevo hay que cargarlos para que no le pise mal los
        // campos de otro cliente.
        ...(body.propiedadInteresFieldId ? { propiedadInteresFieldId: body.propiedadInteresFieldId.trim() } : {}),
        ...(body.motivoHandoffFieldId ? { motivoHandoffFieldId: body.motivoHandoffFieldId.trim() } : {}),
      };
      guardarAgentes(lista);
      return json(res, 200, { ok: true });
    }
    if (mGhlConectar && req.method === 'DELETE') {
      const [, id] = mGhlConectar;
      const lista = leerAgentes();
      const agente = lista.find((a) => a.id === id);
      if (!agente) return json(res, 404, { error: 'No existe ese agente.' });
      delete agente.ghlConfig;
      guardarAgentes(lista);
      return json(res, 200, { ok: true });
    }

    const mAgente = url.pathname.match(/^\/api\/admin\/agentes\/([^/]+)\/(activar|revocar)$/);
    if (mAgente && req.method === 'POST') {
      const [, id, accion] = mAgente;
      const lista = leerAgentes();
      const agente = lista.find((a) => a.id === id);
      if (!agente) return json(res, 404, { error: 'No existe ese agente.' });
      agente.activo = accion === 'activar';
      guardarAgentes(lista);
      return json(res, 200, { ok: true, activo: agente.activo });
    }

    // Alertas de match de TODOS los agentes juntas (para el panel de José
    // Luis) — cada agente ve las suyas por separado vía GET /api/alertas.
    if (url.pathname === '/api/admin/alertas' && req.method === 'GET') {
      let archivos = [];
      try {
        archivos = fs.readdirSync(DATA_DIR).filter((f) => /^alertas-.+\.json$/.test(f));
      } catch {}
      const todas = [];
      for (const archivo of archivos) {
        const agenteId = archivo.replace(/^alertas-/, '').replace(/\.json$/, '');
        let lista = [];
        try {
          lista = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivo), 'utf8'));
        } catch {}
        for (const a of lista) todas.push({ ...a, agenteId });
      }
      todas.sort((a, b) => new Date(b.creado) - new Date(a.creado));
      return json(res, 200, todas);
    }

    // Marcar una alerta como leída desde el panel admin (que no tiene la
    // apiKey del agente dueño de la alerta — solo X-Admin-Key).
    const mAlerta = url.pathname.match(/^\/api\/admin\/alertas\/([^/]+)\/([^/]+)\/leida$/);
    if (mAlerta && req.method === 'POST') {
      const [, agenteIdAlerta, id] = mAlerta;
      const ok = marcarAlertaLeida(agenteIdAlerta, id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No existe esa alerta' });
    }

    if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
      return json(res, 200, leerFeedback());
    }
    const mFeedbackLeido = url.pathname.match(/^\/api\/admin\/feedback\/([^/]+)\/leido$/);
    if (mFeedbackLeido && req.method === 'POST') {
      const [, id] = mFeedbackLeido;
      const lista = leerFeedback();
      const idx = lista.findIndex((f) => f.id === id);
      if (idx === -1) return json(res, 404, { error: 'No existe ese feedback' });
      lista[idx].leido = true;
      guardarFeedbackLista(lista);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/admin/actividad-inventario' && req.method === 'GET') {
      return json(res, 200, leerActividadInventario());
    }
    const mActividadLeida = url.pathname.match(/^\/api\/admin\/actividad-inventario\/([^/]+)\/leida$/);
    if (mActividadLeida && req.method === 'POST') {
      const [, id] = mActividadLeida;
      const lista = leerActividadInventario();
      const idx = lista.findIndex((a) => a.id === id);
      if (idx === -1) return json(res, 404, { error: 'No existe esa actividad' });
      lista[idx].leido = true;
      guardarActividadInventario(lista);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/admin/visitas' && req.method === 'GET') {
      const visitas = leerVisitas();
      const dias = Object.entries(visitas).sort(([a], [b]) => (a < b ? 1 : -1));
      const total = dias.reduce((s, [, n]) => s + n, 0);
      return json(res, 200, { total, porDia: dias.slice(0, 30) });
    }

    // Fuerza una sincronización de Mobiliario App ahora mismo, sin esperar
    // las 20 horas de la sincronización automática (útil después de un fix
    // en el código de esa fuente, o si se quiere refrescar antes de tiempo).
    if (url.pathname === '/api/admin/mobiliario-resincronizar' && req.method === 'POST') {
      if (sincronizandoMobiliario) return json(res, 200, { ok: true, motivo: 'Ya estaba sincronizando.' });
      sincronizarMobiliario().catch((e) => console.error('Error sincronizando Mobiliario App:', e));
      return json(res, 200, { ok: true });
    }

    // Fuerza la sincronización de requerimientos de GHL ahora mismo, sin
    // esperar la hora de la sincronización automática.
    if (url.pathname === '/api/admin/ghl-resincronizar' && req.method === 'POST') {
      if (sincronizandoRequerimientosGHL) return json(res, 200, { ok: true, motivo: 'Ya estaba sincronizando.' });
      sincronizarRequerimientosGHL().catch((e) => console.error('Error sincronizando requerimientos de GHL:', e));
      return json(res, 200, { ok: true, locations: leerLocationsGHL().length });
    }

    return json(res, 404, { error: 'Ruta de administración no encontrada.' });
  }

  // Vitrina pública: el link que el agente comparte con colegas para mostrar
  // SU inventario ("mio", disponible) tipo portal, sin que el que la ve
  // necesite cuenta ni key. Nunca expone las captaciones "otro" (son notas
  // privadas del agente sobre propiedades ajenas, no su propia oferta).
  const mVitrina = url.pathname.match(/^\/api\/vitrina\/([^/]+)$/);
  if (mVitrina && req.method === 'GET') {
    const [, id] = mVitrina;
    const agenteVitrina = leerAgentes().find((a) => a.id === id);
    if (!agenteVitrina) return json(res, 404, { error: 'No existe esa vitrina.' });
    const propiedades = leerInventario(id)
      .filter((i) => i.categoria === 'mio' && i.estado === 'disponible')
      .map((i) => ({
        id: i.id,
        titulo: i.titulo,
        descripcion: i.descripcion,
        operacion: i.operacion,
        tipo: i.tipo,
        precio: i.precio,
        zona: i.zona,
        dormitorios: i.dormitorios,
        banos: i.banos,
        m2Terreno: i.m2Terreno,
        m2Construccion: i.m2Construccion,
        fotos: i.fotos || [],
        carpetaDriveUrl: i.fotosCarpetaDrive || null,
      }));
    return json(res, 200, {
      agente: {
        nombre: agenteVitrina.nombre,
        telefonoContacto: agenteVitrina.telefonoContacto || '',
        inmobiliaria: agenteVitrina.inmobiliaria || '',
        oficina: agenteVitrina.oficina || '',
        fotoPerfil: agenteVitrina.fotoPerfil || '',
      },
      propiedades,
    });
  }

  // Chat con IA sobre esa vitrina — pública también, mismo criterio que el
  // GET de arriba: cualquier colega con el link puede preguntar, sin cuenta.
  const mVitrinaPreguntar = url.pathname.match(/^\/api\/vitrina\/([^/]+)\/preguntar$/);
  if (mVitrinaPreguntar && req.method === 'POST') {
    const [, id] = mVitrinaPreguntar;
    const agenteVitrina = leerAgentes().find((a) => a.id === id);
    if (!agenteVitrina) return json(res, 404, { error: 'No existe esa vitrina.' });
    const body = await leerBody(req);
    const pregunta = (body.pregunta || '').trim();
    if (!pregunta) return json(res, 400, { error: 'Falta la pregunta.' });
    if (!iaDisponible()) return json(res, 200, { respuesta: null, error: 'La IA no está configurada todavía.' });
    const propiedades = leerInventario(id)
      .filter((i) => i.categoria === 'mio' && i.estado === 'disponible')
      .map((i) => ({
        titulo: i.titulo, tipo: i.tipo, operacion: i.operacion, precio: i.precio, zona: i.zona,
        dormitorios: i.dormitorios, banos: i.banos, m2Terreno: i.m2Terreno, m2Construccion: i.m2Construccion,
        descripcion: i.descripcion,
      }));
    try {
      const respuesta = await preguntarInventarioConIA(pregunta, propiedades, agenteVitrina.nombre);
      return json(res, 200, { respuesta });
    } catch (e) {
      return json(res, 500, { error: 'Error al consultar la IA.' });
    }
  }

  // Meta Ads — callback de OAuth: Meta redirige el navegador acá directo
  // (sin X-Api-Key), así que tiene que ser público. El "state" es el
  // agenteId que inició la conexión (viene de /api/meta/conectar, que sí
  // exige sesión) — así se sabe a qué cuenta guardarle el token.
  if (url.pathname === '/api/meta/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const agenteIdCallback = url.searchParams.get('state');
    if (!code || !agenteIdCallback || !metaConfigurado()) {
      res.writeHead(302, { Location: '/inventario.html?metaError=1' });
      return res.end();
    }
    try {
      const tokenUrl =
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(metaRedirectUri())}&client_secret=${process.env.META_APP_SECRET}&code=${code}`;
      const tokenData = await (await fetch(tokenUrl)).json();
      if (!tokenData.access_token) throw new Error('Meta no devolvió access_token');

      // Canje por token de larga duración (~60 días) — el que devuelve el
      // login inicial dura solo horas.
      const largoUrl =
        `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token` +
        `&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`;
      const largoData = await (await fetch(largoUrl)).json();
      const accessToken = largoData.access_token || tokenData.access_token;
      const expiraEn = largoData.expires_in ? new Date(Date.now() + largoData.expires_in * 1000).toISOString() : null;

      const cuentasData = await (
        await fetch(`https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id&access_token=${accessToken}`)
      ).json();
      const primeraCuenta = cuentasData.data && cuentasData.data[0];

      const lista = leerAgentes();
      const idx = lista.findIndex((a) => a.id === agenteIdCallback);
      if (idx !== -1) {
        lista[idx] = {
          ...lista[idx],
          metaAccessToken: accessToken,
          metaTokenExpira: expiraEn,
          metaAdAccountId: primeraCuenta ? primeraCuenta.id : null,
          metaAdAccountNombre: primeraCuenta ? primeraCuenta.name : null,
        };
        guardarAgentes(lista);
      }
      res.writeHead(302, { Location: '/inventario.html?metaConectado=1' });
      return res.end();
    } catch (e) {
      console.error('Error en callback de Meta Ads:', e.message);
      res.writeHead(302, { Location: '/inventario.html?metaError=1' });
      return res.end();
    }
  }

  // En modo multiagente, toda otra ruta /api/* exige una key válida.
  if (url.pathname.startsWith('/api/') && requiereAuth && !agente) {
    return json(res, 401, { error: 'Falta iniciar sesión o tener una clave de acceso válida.' });
  }

  const agenteId = agente ? agente.id : null;

  if (url.pathname === '/api/requerimientos' && req.method === 'GET') {
    return json(res, 200, leerRequerimientos(agenteId));
  }
  if (url.pathname === '/api/requerimientos' && req.method === 'POST') {
    const body = await leerBody(req);
    const lista = leerRequerimientos(agenteId);
    const nuevo = {
      id: Date.now().toString(36),
      creado: new Date().toISOString(),
      ...camposRequerimiento(body),
    };
    lista.unshift(nuevo);
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, nuevo);
  }
  // Registro de "propiedades ya enviadas" por requerimiento — para que el
  // agente vea de un vistazo qué le mandó a cada lead y no le repita lo
  // mismo. Se identifica cada propiedad por su `link` (único por aviso en
  // las 4 fuentes). Vive embebido en el propio requerimiento (r.enviados),
  // no en un archivo aparte.
  // OJO: este bloque va ANTES de los handlers genéricos PUT/DELETE de abajo
  // (que usan startsWith + .pop() sobre /api/requerimientos/) porque si no
  // esos interceptan primero cualquier sub-path como .../enviados.
  const mEnviados = url.pathname.match(/^\/api\/requerimientos\/([^/]+)\/enviados$/);
  if (mEnviados && req.method === 'POST') {
    const [, id] = mEnviados;
    const body = await leerBody(req);
    if (!body.link) return json(res, 400, { error: 'Falta el link de la propiedad.' });
    const lista = leerRequerimientos(agenteId);
    const idx = lista.findIndex((r) => r.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese requerimiento' });
    const enviados = lista[idx].enviados || [];
    if (!enviados.some((e) => e.link === body.link)) {
      enviados.push({
        link: body.link,
        fuente: body.fuente || '',
        titulo: body.titulo || '(sin título)',
        precio: body.precio ?? null,
        zona: body.zona || '',
        fecha: new Date().toISOString(),
      });
    }
    lista[idx] = { ...lista[idx], enviados };
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, lista[idx]);
  }
  if (mEnviados && req.method === 'DELETE') {
    const [, id] = mEnviados;
    const body = await leerBody(req);
    const lista = leerRequerimientos(agenteId);
    const idx = lista.findIndex((r) => r.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese requerimiento' });
    lista[idx] = { ...lista[idx], enviados: (lista[idx].enviados || []).filter((e) => e.link !== body.link) };
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, lista[idx]);
  }

  // Historial de comentarios por lead (seguimiento libre — "llamé y no
  // contestó", "quiere ver el sábado", etc.) — mismo criterio que enviados:
  // varias entradas con fecha, no un campo único que se pisa cada vez. Va
  // ANTES de los handlers genéricos PUT/DELETE por el mismo motivo que
  // mEnviados (startsWith + .pop() interceptaría el sub-path si no).
  const mComentarios = url.pathname.match(/^\/api\/requerimientos\/([^/]+)\/comentarios$/);
  if (mComentarios && req.method === 'POST') {
    const [, id] = mComentarios;
    const body = await leerBody(req);
    const texto = (body.texto || '').trim();
    if (!texto) return json(res, 400, { error: 'Falta el texto del comentario.' });
    const lista = leerRequerimientos(agenteId);
    const idx = lista.findIndex((r) => r.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese requerimiento' });
    const comentarios = lista[idx].comentarios || [];
    comentarios.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), texto, fecha: new Date().toISOString() });
    lista[idx] = { ...lista[idx], comentarios };
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, lista[idx]);
  }
  if (mComentarios && req.method === 'DELETE') {
    const [, id] = mComentarios;
    const body = await leerBody(req);
    const lista = leerRequerimientos(agenteId);
    const idx = lista.findIndex((r) => r.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese requerimiento' });
    lista[idx] = { ...lista[idx], comentarios: (lista[idx].comentarios || []).filter((c) => c.id !== body.id) };
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, lista[idx]);
  }

  if (url.pathname.startsWith('/api/requerimientos/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const body = await leerBody(req);
    const lista = leerRequerimientos(agenteId);
    const idx = lista.findIndex((r) => r.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese requerimiento' });
    // Bug real encontrado 2026-08-17: un PUT parcial (ej. {tipo:'departamento'})
    // pisaba TODOS los campos no incluidos en el body a su default, porque
    // camposRequerimiento(body) siempre arma un objeto completo — acá se
    // fusiona sobre el registro existente ANTES de normalizar, para que un
    // campo omitido conserve su valor actual en vez de borrarse.
    const actualizado = { ...lista[idx], ...camposRequerimiento({ ...lista[idx], ...body }) };
    lista[idx] = actualizado;
    guardarRequerimientos(lista, agenteId);
    return json(res, 200, actualizado);
  }
  if (url.pathname.startsWith('/api/requerimientos/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    guardarRequerimientos(leerRequerimientos(agenteId).filter((r) => r.id !== id), agenteId);
    return json(res, 200, { ok: true });
  }

  // Carga manual de una propiedad nueva (ej. desde la Ficha Técnica) — corre
  // matcheaPropiedad contra los requerimientos guardados del agente (mismo
  // tipo+operación) y genera una alerta por cada match encontrado.
  if (url.pathname === '/api/propiedades' && req.method === 'POST') {
    const body = await leerBody(req);
    const propiedad = {
      fuente: 'manual',
      titulo: (body.titulo || '(sin título)').trim(),
      precio: parsePrecio(body.precio),
      dormitorios: body.dormitorios ? Number(body.dormitorios) : null,
      banos: body.banos ? Number(body.banos) : null,
      m2Terreno: body.m2Terreno ? Number(body.m2Terreno) : null,
      m2Construccion: body.m2Construccion ? Number(body.m2Construccion) : null,
      zona: (body.zona || '').trim(),
      direccion: (body.direccion || '').trim(),
      descripcion: (body.descripcion || '').trim(),
      fecha: body.fecha || new Date().toISOString(),
      tipo: TIPOS.has(body.tipo) ? body.tipo : 'casa',
      operacion: body.operacion === 'alquiler' ? 'alquiler' : 'venta',
    };

    // Solo tiene sentido comparar contra requerimientos del mismo tipo y
    // operación — buscarTodo logra esto pidiéndole ese filtro a cada fuente;
    // acá lo hacemos a mano ya que la propiedad no viene de una búsqueda.
    const candidatos = leerRequerimientos(agenteId).filter(
      (r) => r.tipo === propiedad.tipo && r.operacion === propiedad.operacion
    );
    const matches = candidatos.filter((r) => matcheaPropiedad({ ...propiedad }, r));

    const alertas = matches.map((r) =>
      guardarAlerta(agenteId, {
        origen: 'manual',
        propiedad: {
          titulo: propiedad.titulo,
          precio: propiedad.precio,
          zona: propiedad.zona,
          tipo: propiedad.tipo,
          operacion: propiedad.operacion,
        },
        requerimiento: {
          id: r.id,
          cliente: r.cliente,
          telefono: r.telefono,
          zona: r.zona,
          precioMin: r.precioMin,
          precioMax: r.precioMax,
        },
      })
    );

    return json(res, 200, { propiedad, matches: matches.length, alertas });
  }

  // Perfil del propio agente (teléfono de contacto de la vitrina, carpeta
  // raíz de Drive) — separado de camposRequerimiento/camposInventario
  // porque esto edita al agente mismo, no un requerimiento. Solo pisa los
  // campos que vienen en el body: como el panel de "Mi vitrina" guarda el
  // teléfono y el de Drive por separado, un PUT no debe borrar el otro.
  if (url.pathname === '/api/perfil' && req.method === 'PUT') {
    const body = await leerBody(req);
    const lista = leerAgentes();
    const idx = lista.findIndex((a) => a.id === agenteId);
    if (idx === -1) return json(res, 404, { error: 'No existe el agente.' });
    const actualizado = { ...lista[idx] };
    if (body.telefonoContacto !== undefined) actualizado.telefonoContacto = String(body.telefonoContacto).trim();
    if (body.telefonoNotificaciones !== undefined) actualizado.telefonoNotificaciones = String(body.telefonoNotificaciones).trim();
    if (body.correoNotificaciones !== undefined) actualizado.correoNotificaciones = String(body.correoNotificaciones).trim();
    if (body.driveRaizUrl !== undefined) actualizado.driveRaizUrl = String(body.driveRaizUrl).trim();
    if (body.inmobiliaria !== undefined) actualizado.inmobiliaria = String(body.inmobiliaria).trim();
    if (body.oficina !== undefined) actualizado.oficina = String(body.oficina).trim();
    // Límite generoso pero real: la foto ya viene comprimida/achicada del
    // lado del navegador antes de mandarse, esto es solo un tope de
    // seguridad para no dejar crecer agentes.json sin control.
    if (body.fotoPerfil !== undefined) {
      if (body.fotoPerfil && body.fotoPerfil.length > 400000) {
        return json(res, 400, { error: 'La foto es muy pesada — probá con otra más liviana.' });
      }
      actualizado.fotoPerfil = body.fotoPerfil;
    }
    lista[idx] = actualizado;
    guardarAgentes(lista);
    return json(res, 200, {
      ok: true,
      telefonoContacto: actualizado.telefonoContacto || '',
      telefonoNotificaciones: actualizado.telefonoNotificaciones || '',
      correoNotificaciones: actualizado.correoNotificaciones || '',
      driveRaizUrl: actualizado.driveRaizUrl || '',
      inmobiliaria: actualizado.inmobiliaria || '',
      oficina: actualizado.oficina || '',
      fotoPerfil: actualizado.fotoPerfil || '',
    });
  }

  // Meta Ads: arma el link de login de Facebook para que el agente conecte
  // SU PROPIA cuenta publicitaria — el "state" lleva el agenteId para que
  // el callback (público, más arriba) sepa a quién guardarle el token.
  if (url.pathname === '/api/meta/conectar' && req.method === 'GET') {
    if (!metaConfigurado()) return json(res, 400, { error: 'Meta Ads no está configurado todavía en el servidor.' });
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: metaRedirectUri(),
      scope: 'ads_read',
      state: agenteId,
      response_type: 'code',
    });
    return json(res, 200, { url: 'https://www.facebook.com/v19.0/dialog/oauth?' + params.toString() });
  }

  if (url.pathname === '/api/meta/estado' && req.method === 'GET') {
    const ag = leerAgentes().find((a) => a.id === agenteId);
    return json(res, 200, {
      configuradoServidor: metaConfigurado(),
      conectado: !!(ag && ag.metaAccessToken),
      cuenta: ag ? ag.metaAdAccountNombre || null : null,
    });
  }

  if (url.pathname === '/api/meta/desconectar' && req.method === 'POST') {
    const lista = leerAgentes();
    const idx = lista.findIndex((a) => a.id === agenteId);
    if (idx !== -1) {
      lista[idx] = { ...lista[idx], metaAccessToken: null, metaTokenExpira: null, metaAdAccountId: null, metaAdAccountNombre: null };
      guardarAgentes(lista);
    }
    return json(res, 200, { ok: true });
  }

  // Gasto/leads/costo por lead de la cuenta publicitaria conectada — solo
  // lectura contra la Marketing API de Meta con el token propio del agente.
  if (url.pathname === '/api/meta/insights' && req.method === 'GET') {
    const ag = leerAgentes().find((a) => a.id === agenteId);
    if (!ag || !ag.metaAccessToken || !ag.metaAdAccountId) {
      return json(res, 400, { error: 'Todavía no conectaste tu cuenta de Meta Ads.' });
    }
    try {
      const rango = url.searchParams.get('rango') || 'last_30d';
      const campos = 'spend,impressions,clicks,actions';
      const insightsUrl =
        `https://graph.facebook.com/v19.0/${ag.metaAdAccountId}/insights?fields=${campos}` +
        `&date_preset=${rango}&access_token=${ag.metaAccessToken}`;
      const data = await (await fetch(insightsUrl)).json();
      if (data.error) throw new Error(data.error.message);
      const fila = (data.data && data.data[0]) || {};
      const leads = (fila.actions || [])
        .filter((a) => String(a.action_type || '').includes('lead'))
        .reduce((s, a) => s + Number(a.value || 0), 0);
      const gasto = Number(fila.spend) || 0;
      return json(res, 200, {
        cuenta: ag.metaAdAccountNombre,
        gasto,
        impresiones: Number(fila.impressions) || 0,
        clics: Number(fila.clicks) || 0,
        leads,
        costoPorLead: leads ? gasto / leads : null,
      });
    } catch (e) {
      return json(res, 500, { error: 'No se pudo leer Meta Ads: ' + e.message });
    }
  }

  // Red entre agentes: preguntar en lenguaje natural si algún OTRO agente
  // de la plataforma tiene una propiedad que calce. SOLO LECTURA — nunca
  // escribe en el inventario de nadie (ver leerInventarioDeTodosLosAgentes).
  // Si nadie en la red lo tiene, cae automáticamente a buscar en los
  // portales reales (mismo motor que la búsqueda normal).
  if (url.pathname === '/api/red/preguntar' && req.method === 'POST') {
    const body = await leerBody(req);
    const pregunta = (body.pregunta || '').trim();
    if (!pregunta) return json(res, 400, { error: 'Falta la pregunta.' });
    if (!iaDisponible()) return json(res, 200, { respuesta: null, error: 'La IA no está configurada todavía.' });

    const criterios = await interpretarConIA(pregunta);
    if (!criterios || !criterios.tipo) {
      return json(res, 200, { respuesta: 'No entendí bien qué estás buscando — probá ser más específico (tipo de propiedad, zona, dormitorios).' });
    }
    criterios.operacion = criterios.operacion === 'alquiler' ? 'alquiler' : 'venta';

    const propiedadesRed = leerInventarioDeTodosLosAgentes(agenteId);
    const candidatas = propiedadesRed.filter((p) => p.tipo === criterios.tipo && p.operacion === criterios.operacion);
    const matches = candidatas.filter((p) => matcheaPropiedad({ ...p }, criterios));

    if (matches.length) {
      const respuesta = await preguntarRedConIA(pregunta, matches);
      return json(res, 200, { respuesta, matches: matches.length, fuente: 'red', propiedades: matches.slice(0, 8) });
    }

    try {
      const resultadoPortales = await buscarTodo(criterios);
      return json(res, 200, {
        respuesta: resultadoPortales.listados.length
          ? `Ningún colega tiene esto en su inventario todavía. Busqué en los portales y encontré ${resultadoPortales.listados.length} propiedad(es) — mirá la sección de resultados.`
          : 'Ningún colega tiene esto en su inventario, y tampoco encontré nada en los portales con esos criterios por ahora.',
        matches: 0,
        fuente: 'portales',
        listados: resultadoPortales.listados.slice(0, 12),
      });
    } catch {
      return json(res, 200, { respuesta: 'Ningún colega tiene esto en su inventario. No pude buscar en los portales en este momento — probá de nuevo en un rato.', matches: 0, fuente: 'ninguna' });
    }
  }

  // ---------- Inventario propio ----------
  if (url.pathname === '/api/inventario' && req.method === 'GET') {
    return json(res, 200, leerInventario(agenteId));
  }
  // Sincroniza desde la carpeta raíz de Drive conectada en el perfil: crea
  // o actualiza un ítem por cada subcarpeta (una propiedad por subcarpeta).
  if (url.pathname === '/api/inventario/sincronizar-drive' && req.method === 'POST') {
    const resultado = await sincronizarInventarioDesdeDrive(agenteId);
    if (resultado.error) return json(res, 400, resultado);
    return json(res, 200, resultado);
  }
  // Captura rápida: interpreta con IA el texto de un mensaje de WhatsApp de
  // otro agente y devuelve los campos ya listos para prellenar el
  // formulario — no guarda nada todavía, eso lo hace el POST normal cuando
  // el agente confirma/edita y le da Guardar.
  if (url.pathname === '/api/inventario/interpretar-captacion' && req.method === 'POST') {
    const body = await leerBody(req);
    const texto = (body.texto || '').trim();
    if (!texto) return json(res, 400, { error: 'Falta el texto del mensaje.' });
    if (!iaDisponible()) return json(res, 200, { error: 'La IA no está configurada todavía — completá el formulario a mano.' });
    const campos = await interpretarCaptacionConIA(texto);
    if (!campos) return json(res, 200, { error: 'No pude interpretar el mensaje — completá el formulario a mano.' });
    return json(res, 200, { campos });
  }

  if (url.pathname === '/api/inventario' && req.method === 'POST') {
    const body = await leerBody(req);
    const nuevo = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      creado: new Date().toISOString(),
      ultimaConfirmacion: new Date().toISOString(),
      comentarios: [],
      fotos: [],
      historialPrecios: [],
      ...camposInventario(body),
    };
    if (nuevo.precio) nuevo.historialPrecios = [{ precio: nuevo.precio, fecha: nuevo.creado }];
    if (nuevo.fotosCarpetaDrive) nuevo.fotos = await resolverFotosDrive(nuevo.fotosCarpetaDrive);
    // Captura rápida (o cualquier alta manual): fotos subidas directo desde
    // el navegador, ya redimensionadas ahí — solo aplica cuando no hay
    // carpeta de Drive (esa gana, es la fuente "viva").
    else if (Array.isArray(body.fotos)) nuevo.fotos = body.fotos.filter((f) => typeof f === 'string' && f.length < 700000).slice(0, 6);
    const lista = leerInventario(agenteId);
    lista.unshift(nuevo);
    guardarInventario(lista, agenteId);
    const alertas = matchearInventarioConRequerimientos(nuevo, agenteId);
    registrarActividadInventario(agenteId, 'creado', { titulo: nuevo.titulo, tipo: nuevo.tipo });
    return json(res, 200, { item: nuevo, matches: alertas.length });
  }

  // Cambio de precio rápido (desde el listado, sin abrir el formulario
  // completo) — endpoint aparte del PUT genérico porque ese reconstruye
  // TODOS los campos desde camposInventario y borraría el resto de datos
  // del ítem si solo mandamos el precio. Cada cambio queda en
  // historialPrecios para poder ver la evolución de precio con el tiempo.
  const mInventarioPrecio = url.pathname.match(/^\/api\/inventario\/([^/]+)\/precio$/);
  if (mInventarioPrecio && req.method === 'PUT') {
    const [, id] = mInventarioPrecio;
    const body = await leerBody(req);
    const precio = parsePrecio(body.precio);
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    const historial = lista[idx].historialPrecios || [];
    const cambio = precio !== lista[idx].precio;
    if (cambio) historial.push({ precio, fecha: new Date().toISOString() });
    lista[idx] = { ...lista[idx], precio, historialPrecios: historial };
    guardarInventario(lista, agenteId);
    if (cambio) registrarActividadInventario(agenteId, 'actualizado', { titulo: lista[idx].titulo, precio });
    return json(res, 200, lista[idx]);
  }

  const mInventarioConfirmar = url.pathname.match(/^\/api\/inventario\/([^/]+)\/confirmar$/);
  if (mInventarioConfirmar && req.method === 'POST') {
    const [, id] = mInventarioConfirmar;
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    lista[idx] = { ...lista[idx], ultimaConfirmacion: new Date().toISOString() };
    guardarInventario(lista, agenteId);
    return json(res, 200, lista[idx]);
  }

  const mInventarioComentarios = url.pathname.match(/^\/api\/inventario\/([^/]+)\/comentarios$/);
  if (mInventarioComentarios && req.method === 'POST') {
    const [, id] = mInventarioComentarios;
    const body = await leerBody(req);
    const texto = (body.texto || '').trim();
    if (!texto) return json(res, 400, { error: 'Falta el texto del comentario.' });
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    const comentarios = lista[idx].comentarios || [];
    comentarios.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), texto, fecha: new Date().toISOString() });
    lista[idx] = { ...lista[idx], comentarios };
    guardarInventario(lista, agenteId);
    return json(res, 200, lista[idx]);
  }
  if (mInventarioComentarios && req.method === 'DELETE') {
    const [, id] = mInventarioComentarios;
    const body = await leerBody(req);
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    lista[idx] = { ...lista[idx], comentarios: (lista[idx].comentarios || []).filter((c) => c.id !== body.id) };
    guardarInventario(lista, agenteId);
    return json(res, 200, lista[idx]);
  }

  const mInventarioRefrescarFotos = url.pathname.match(/^\/api\/inventario\/([^/]+)\/refrescar-fotos$/);
  if (mInventarioRefrescarFotos && req.method === 'POST') {
    const [, id] = mInventarioRefrescarFotos;
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    lista[idx] = { ...lista[idx], fotos: await resolverFotosDrive(lista[idx].fotosCarpetaDrive) };
    guardarInventario(lista, agenteId);
    return json(res, 200, lista[idx]);
  }

  if (url.pathname.startsWith('/api/inventario/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    const lista = leerInventario(agenteId);
    const idx = lista.findIndex((i) => i.id === id);
    if (idx === -1) return json(res, 404, { error: 'No existe ese ítem de inventario.' });
    const body = await leerBody(req);
    // Mismo bug real que en requerimientos (2026-08-17): un PUT parcial
    // pisaba a su default cualquier campo no incluido en el body, porque
    // camposInventario(body) siempre arma un objeto completo — se fusiona
    // sobre el ítem existente ANTES de normalizar.
    const actualizado = { ...lista[idx], ...camposInventario({ ...lista[idx], ...body }) };
    if (actualizado.precio !== lista[idx].precio) {
      actualizado.historialPrecios = [...(lista[idx].historialPrecios || []), { precio: actualizado.precio, fecha: new Date().toISOString() }];
    }
    if (actualizado.fotosCarpetaDrive) actualizado.fotos = await resolverFotosDrive(actualizado.fotosCarpetaDrive);
    else if (Array.isArray(body.fotos)) actualizado.fotos = body.fotos.filter((f) => typeof f === 'string' && f.length < 700000).slice(0, 6);
    lista[idx] = actualizado;
    guardarInventario(lista, agenteId);
    const alertas = matchearInventarioConRequerimientos(actualizado, agenteId);
    registrarActividadInventario(agenteId, 'actualizado', { titulo: actualizado.titulo, tipo: actualizado.tipo });
    return json(res, 200, { item: actualizado, matches: alertas.length });
  }
  if (url.pathname.startsWith('/api/inventario/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    guardarInventario(leerInventario(agenteId).filter((i) => i.id !== id), agenteId);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/alertas' && req.method === 'GET') {
    return json(res, 200, leerAlertas(agenteId));
  }
  // Registro de qué se le mandó directo a cada cliente (auditoría, solo lectura).
  if (url.pathname === '/api/envios-clientes' && req.method === 'GET') {
    return json(res, 200, leerEnviosClientes(agenteId));
  }
  // Registro de captadores (agentes de otras fuentes que capturaron una
  // propiedad que le mandamos a algún cliente) — deduplicado, con todas sus
  // propiedades juntas, para que el agente pueda ubicarlos y gestionar.
  if (url.pathname === '/api/captadores' && req.method === 'GET') {
    return json(res, 200, leerCaptadores(agenteId));
  }

  // Reporte de zona: "todo lo que se está vendiendo/alquilando en una zona",
  // no una búsqueda filtrada por presupuesto/palabras de UN cliente. Se arma
  // con los mismos 4 portales (buscarTodo), pero solo con tipo/operación/
  // zona/m² — sin precio, sin "palabras", sin filtroEstricto — para que sea
  // la foto completa del mercado, no un subconjunto. De paso, registra cada
  // agente/inmobiliaria encontrado en la base de captadores del agente.
  if (url.pathname === '/api/reporte-zona' && req.method === 'POST') {
    const body = await leerBody(req);
    if (!body.tipo || !body.operacion) return json(res, 400, { error: 'Faltan tipo y operación.' });
    if (!Array.isArray(body.propiedades)) return json(res, 400, { error: 'Faltan las propiedades a incluir en el reporte.' });
    try {
      // Bug real reportado por José Luis el 2026-08-18: la primera versión
      // volvía a llamar a buscarTodo acá con solo tipo/operación/zona/m² (sin
      // precio/palabras/filtroEstricto/excluir), así que el reporte terminaba
      // trayendo terrenos DISTINTOS a los que él tenía en pantalla — más
      // amplios que su búsqueda puntual. Ahora el reporte usa exactamente los
      // resultados que el frontend ya tiene en pantalla (ultimosListados, con
      // TODOS los filtros de esa búsqueda ya aplicados), no una re-búsqueda
      // con criterios recortados. Lo único que sigue siendo "de la zona
      // completa" es que ya no está atado al presupuesto de un cliente si el
      // agente buscó sin precio — pero nunca inventa resultados que no
      // estaban en la búsqueda que el agente hizo.
      const propiedades = body.propiedades;
      registrarCaptadores(agenteId, propiedades);

      const conUsdM2 = propiedades
        .map((it) => {
          const m2 = body.tipo === 'terreno' ? it.m2Terreno : it.m2Construccion || it.m2Terreno;
          return it.precio && m2 ? it.precio / m2 : null;
        })
        .filter((n) => n != null);
      const precios = propiedades.map((it) => it.precio).filter((n) => n != null);
      const resumen = {
        cantidad: propiedades.length,
        precioMin: precios.length ? Math.min(...precios) : null,
        precioMax: precios.length ? Math.max(...precios) : null,
        precioM2Promedio: conUsdM2.length ? Math.round(conUsdM2.reduce((a, b) => a + b, 0) / conUsdM2.length) : null,
      };
      const porFuente = {};
      for (const it of propiedades) porFuente[it.fuente] = (porFuente[it.fuente] || 0) + 1;

      const registro = guardarReporteZona(agenteId, {
        criterios: { tipo: body.tipo, operacion: body.operacion, zona: body.zona || '' },
        tituloCliente: body.tituloCliente || '',
        resumen,
        // Snapshot liviano — no todo el objeto de buscarTodo. asesor/oficina/
        // link quedan guardados acá para el propio José Luis (los ve si abre
        // el reporte desde su panel), pero paginaReporteZona nunca los
        // renderiza en la versión pública.
        propiedades: propiedades.map((it) => ({
          titulo: it.titulo,
          precio: it.precio ?? null,
          zona: it.zona || '',
          dormitorios: it.dormitorios ?? null,
          banos: it.banos ?? null,
          m2Terreno: it.m2Terreno ?? null,
          m2Construccion: it.m2Construccion ?? null,
          imagen: it.imagen || '',
          imagenes: Array.isArray(it.imagenes) && it.imagenes.length ? it.imagenes : it.imagen ? [it.imagen] : [],
          fuente: it.fuente,
          link: it.link || '',
          asesor: it.asesor || '',
          oficina: it.oficina || '',
        })),
      });

      return json(res, 200, {
        id: registro.id,
        urlPublica: `${BASE_URL_APP}/reporte/${agenteId}/${registro.id}`,
        resumen,
        porFuente,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // Historial de reportes de zona ya generados — para reabrirlos sin
  // regenerar (el link público ya sirve solo, esto es para que José Luis los
  // encuentre de nuevo desde la app sin tener que guardar el link a mano).
  if (url.pathname === '/api/reportes-zona' && req.method === 'GET') {
    const lista = leerReportesZona(agenteId).map((r) => ({
      id: r.id,
      creado: r.creado,
      criterios: r.criterios,
      tituloCliente: r.tituloCliente,
      resumen: r.resumen,
      urlPublica: `${BASE_URL_APP}/reporte/${agenteId}/${r.id}`,
    }));
    return json(res, 200, lista);
  }
  if (url.pathname.startsWith('/api/alertas/') && url.pathname.endsWith('/leida') && req.method === 'POST') {
    const id = url.pathname.split('/')[3];
    const ok = marcarAlertaLeida(agenteId, id);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No existe esa alerta' });
  }

  // Feedback de agentes — sugerencias/quejas/comentarios sobre la app en sí,
  // no sobre un lead puntual (eso son los comentarios de requerimientos).
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    const body = await leerBody(req);
    const texto = (body.texto || '').trim();
    if (!texto) return json(res, 400, { error: 'Falta el texto del feedback.' });
    const agenteActual = leerAgentes().find((a) => a.id === agenteId);
    const lista = leerFeedback();
    lista.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      agenteId,
      agenteNombre: agenteActual ? agenteActual.nombre : 'Agente',
      texto,
      fecha: new Date().toISOString(),
      leido: false,
    });
    guardarFeedbackLista(lista);
    return json(res, 200, { ok: true });
  }

  // Estado de la IA (para que la interfaz sepa si mostrar los botones)
  if (url.pathname === '/api/ia-estado' && req.method === 'GET') {
    return json(res, 200, estadoIA());
  }

  // Zonas reales de Santa Cruz (para el selector/autocompletado del formulario)
  if (url.pathname === '/api/zonas' && req.method === 'GET') {
    return json(res, 200, { zonas: ZONAS, rapidas: ZONAS_RAPIDAS });
  }

  // Estado de la sincronización de Mobiliario App (para mostrar progreso en la interfaz)
  if (url.pathname === '/api/mobiliario-estado' && req.method === 'GET') {
    const cache = leerCacheMobiliario();
    return json(res, 200, {
      sincronizadoEn: cache.sincronizadoEn,
      enProgreso: cache.enProgreso,
      progreso: cache.progreso || null,
      ultimoError: cache.ultimoError,
      cantidad: Object.values(cache.listados || {}).filter((v) => v.item).length,
    });
  }

  // Estado de la sincronización de requerimientos de GHL
  if (url.pathname === '/api/ghl-sync-estado' && req.method === 'GET') {
    return json(res, 200, { ...leerEstadoGHL(), locationsConfiguradas: leerLocationsGHL().length });
  }

  // Interpretar el pedido del cliente con IA (con fallback: la interfaz usa su
  // intérprete local si la IA no está disponible)
  if (url.pathname === '/api/interpretar' && req.method === 'POST') {
    const body = await leerBody(req);
    if (!iaDisponible()) return json(res, 200, { disponible: false, campos: null });
    try {
      const campos = await interpretarConIA(body.texto || '');
      return json(res, 200, { disponible: true, campos });
    } catch (e) {
      return json(res, 200, { disponible: false, campos: null, error: e.message });
    }
  }

  if (url.pathname === '/api/buscar' && req.method === 'GET') {
    const params = Object.fromEntries(url.searchParams);
    try {
      const resultado = await buscarTodo(params);
      // Cada búsqueda interactiva alimenta la base de agentes/captadores del
      // agente logueado (data/captadores-<agenteId>.json) — antes esto solo
      // pasaba en el barrido automático de GHL. José Luis lo pidió el
      // 2026-08-15: quiere que CADA búsqueda que hace vaya construyendo su
      // propia base de datos de qué agente/inmobiliaria vende qué, no solo
      // cuando hay un lead de GHL de por medio.
      if (agenteId) registrarCaptadores(agenteId, resultado.listados);
      resultado.linksExternos = linksExternos(params);
      if (iaDisponible() && params.resumir === '1') {
        try {
          resultado.resumenIA = await resumirConIA(params, resultado.listados);
        } catch (e) {
          resultado.resumenIA = null;
        }
      }
      if (iaDisponible() && params.acm === '1') {
        try {
          resultado.analisisMercadoIA = await generarACM(params, resultado.analisisMercado);
        } catch (e) {
          resultado.analisisMercadoIA = null;
        }
      }
      return json(res, 200, resultado);
    } catch (e) {
      return json(res, 500, { error: e.message, listados: [] });
    }
  }

  if (url.pathname === '/' && req.method === 'GET') registrarVisita();

  const archivo = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const ruta = path.join(PUBLIC_DIR, archivo);
  if (ruta.startsWith(PUBLIC_DIR) && fs.existsSync(ruta) && fs.statSync(ruta).isFile()) {
    const ext = path.extname(ruta);
    const tipos = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, { 'Content-Type': (tipos[ext] || 'text/plain') + '; charset=utf-8' });
    return res.end(fs.readFileSync(ruta));
  }

  res.writeHead(404);
  res.end('No encontrado');
}

const server = http.createServer((req, res) => {
  manejarRequest(req, res).catch((e) => {
    console.error('Error no manejado en', req.method, req.url, ':', e);
    if (!res.headersSent) json(res, 500, { error: 'Error interno del servidor' });
    else res.end();
  });
});

// Red de seguridad final: si algo se escapa de todos los try/catch (un bug
// que no anticipamos), se registra en la consola y el servidor SIGUE
// funcionando — antes esto mataba el proceso y desconectaba a todos los
// agentes conectados por el error de uno solo.
process.on('uncaughtException', (err) => {
  console.error('Excepción no capturada (el servidor sigue funcionando):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Promesa rechazada sin atrapar (el servidor sigue funcionando):', err);
});

// Recorre el inventario de TODOS los agentes y genera una alerta de
// "reconfirmar disponibilidad" para cada ítem disponible que lleve más de
// DIAS_RECONFIRMAR_INVENTARIO sin confirmarse — para "otro" (captación de
// otro agente) el mensaje sugiere preguntarle al captador; para "mio" solo
// pide confirmar. Guarda `ultimaAlertaVencimiento` en el propio ítem para no
// generar la misma alerta de vuelta cada vez que corre este chequeo.
const DIAS_RECONFIRMAR_INVENTARIO = 30;

function chequearReconfirmarInventario() {
  let archivos;
  try {
    archivos = fs.readdirSync(DATA_DIR).filter((f) => /^inventario-.+\.json$/.test(f));
  } catch {
    return;
  }
  for (const archivo of archivos) {
    const agenteId = archivo.replace(/^inventario-/, '').replace(/\.json$/, '');
    const ruta = path.join(DATA_DIR, archivo);
    let lista;
    try {
      lista = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
      continue;
    }
    let cambio = false;
    for (const item of lista) {
      if (item.estado !== 'disponible' || !item.ultimaConfirmacion) continue;
      const diasSinConfirmar = (Date.now() - new Date(item.ultimaConfirmacion).getTime()) / 86400000;
      if (diasSinConfirmar < DIAS_RECONFIRMAR_INVENTARIO) continue;
      const diasDesdeUltimaAlerta = item.ultimaAlertaVencimiento
        ? (Date.now() - new Date(item.ultimaAlertaVencimiento).getTime()) / 86400000
        : Infinity;
      if (diasDesdeUltimaAlerta < DIAS_RECONFIRMAR_INVENTARIO) continue;

      const sugerencia =
        item.categoria === 'otro'
          ? `Preguntale a ${item.captadorNombre || 'el captador'}${item.captadorTelefono ? ' (' + item.captadorTelefono + ')' : ''} si sigue disponible.`
          : 'Confirmá si sigue disponible.';
      guardarAlerta(agenteId, {
        tipo: 'reconfirmar_disponibilidad',
        origen: item.categoria === 'otro' ? 'inventario-otro' : 'inventario-propio',
        propiedad: { id: item.id, titulo: item.titulo, precio: item.precio, zona: item.zona, tipo: item.tipo, operacion: item.operacion },
        mensaje: `Sin confirmar hace ${Math.floor(diasSinConfirmar)} día(s). ${sugerencia}`,
      });
      item.ultimaAlertaVencimiento = new Date().toISOString();
      cambio = true;
    }
    if (cambio) fs.writeFileSync(ruta, JSON.stringify(lista, null, 2));
  }
}

// Revisa si ya pasaron MOBILIARIO_RESYNC_HORAS desde la última sincronización
// completa y, si es así, dispara una nueva (no bloquea nada — fire and
// forget). C21/RE/MAX/BienInmuebles no necesitan esto porque se leen en vivo
// en cada búsqueda; Mobiliario App es la única que depende de esta caché.
function chequearResyncMobiliario() {
  const cache = leerCacheMobiliario();
  const horasDesdeUltimaSync = cache.sincronizadoEn
    ? (Date.now() - new Date(cache.sincronizadoEn).getTime()) / 3600000
    : Infinity;
  // Bug real encontrado 2026-08-24: acá antes también se chequeaba
  // `!cache.enProgreso` (el flag GUARDADO EN DISCO) — pero si el proceso se
  // corta a mitad de una sincronización (pasa seguido: reinicios en
  // desarrollo, un redeploy en producción), ese `enProgreso: true` queda
  // grabado para siempre, porque el `finally` que lo pone en `false` nunca
  // llega a correr. Resultado real observado: Mobiliario App quedó 19 días
  // sin resincronizar, mostrando propiedades ya dadas de baja (links rotos)
  // porque `chequearResyncMobiliario` se negaba a reintentar. La protección
  // contra ejecuciones simultáneas YA la hace `sincronizarMobiliario()` con
  // el flag en MEMORIA `sincronizandoMobiliario` (se resetea solo con cada
  // arranque del proceso) — no hace falta duplicarla acá con un flag que
  // puede quedar "trabado" entre reinicios.
  if (horasDesdeUltimaSync >= MOBILIARIO_RESYNC_HORAS) {
    console.log('Sincronizando Mobiliario App en segundo plano…');
    sincronizarMobiliario().catch((e) => console.error('Error sincronizando Mobiliario App:', e));
  }
}

// Mismo patrón que chequearResyncMobiliario, pero para CapitalCorp — solo
// ~98 avisos, así que cada sincronización completa es rápida.
function chequearResyncCapitalCorp() {
  const cache = leerCacheCapitalCorp();
  const horasDesdeUltimaSync = cache.sincronizadoEn
    ? (Date.now() - new Date(cache.sincronizadoEn).getTime()) / 3600000
    : Infinity;
  // Mismo fix que chequearResyncMobiliario — no gatear con el `enProgreso`
  // persistido en disco, que puede quedar trabado en `true` para siempre si
  // el proceso se corta a mitad de una sincronización.
  if (horasDesdeUltimaSync >= CAPITALCORP_RESYNC_HORAS) {
    console.log('Sincronizando CapitalCorp en segundo plano…');
    sincronizarCapitalCorp().catch((e) => console.error('Error sincronizando CapitalCorp:', e));
  }
}

// Mismo patrón — Alfa Bolivia (~3.300 avisos, más rápido que Mobiliario App
// porque no visita fichas individuales, solo las páginas de listado).
function chequearResyncAlfaBolivia() {
  const cache = leerCacheAlfaBolivia();
  const horasDesdeUltimaSync = cache.sincronizadoEn
    ? (Date.now() - new Date(cache.sincronizadoEn).getTime()) / 3600000
    : Infinity;
  if (horasDesdeUltimaSync >= ALFABOLIVIA_RESYNC_HORAS) {
    console.log('Sincronizando Alfa Bolivia en segundo plano…');
    sincronizarAlfaBolivia().catch((e) => console.error('Error sincronizando Alfa Bolivia:', e));
  }
}

server.listen(PORT, () => {
  console.log(`Buscador de inmuebles corriendo en http://localhost:${PORT}`);

  // Si el servidor se reinicia a mitad de una sincronización (pasa seguido
  // en desarrollo), retoma solo lo que falte gracias al progreso ya
  // guardado en cache-mobiliario.json.
  chequearResyncMobiliario();

  // Antes esto SOLO se chequeaba acá, al arrancar — si el servidor se queda
  // prendido varios días seguidos (lo deseable en producción), nunca se
  // volvía a revisar y Mobiliario App se quedaba desactualizada para
  // siempre después de las primeras horas. Ahora se revisa cada hora
  // mientras el proceso esté vivo, sin importar cuánto tiempo lleve arriba.
  setInterval(chequearResyncMobiliario, 60 * 60 * 1000);

  chequearResyncCapitalCorp();
  setInterval(chequearResyncCapitalCorp, 60 * 60 * 1000);

  chequearResyncAlfaBolivia();
  setInterval(chequearResyncAlfaBolivia, 60 * 60 * 1000);

  // Mismo patrón para los requerimientos de GHL — no hace nada si
  // GHL_LOCATIONS no está configurado (ver leerLocationsGHL).
  chequearResyncRequerimientosGHL();
  setInterval(chequearResyncRequerimientosGHL, 60 * 60 * 1000);

  // Barrido activo de matches (busca en las 4 fuentes para cada requerimiento,
  // no solo espera a que aparezca algo nuevo) — 2 veces al día. Primera
  // corrida a los 10 minutos de arrancar (no al toque, para no competir con
  // la sincronización inicial de Mobiliario App/GHL).
  setTimeout(
    () => barridoMatchesRequerimientos().catch((e) => console.error('Error en primer barrido de matches:', e.message)),
    10 * 60 * 1000
  );
  setInterval(() => barridoMatchesRequerimientos().catch((e) => console.error('Error en barrido de matches:', e.message)), 12 * 60 * 60 * 1000);

  // Reconfirmar disponibilidad del inventario — no necesita frecuencia de
  // hora en hora, se revisa una vez por día.
  chequearReconfirmarInventario();
  setInterval(chequearReconfirmarInventario, 24 * 60 * 60 * 1000);
});
