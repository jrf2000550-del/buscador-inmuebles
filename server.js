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
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requerimientos.json');
const AGENTES_FILE = path.join(DATA_DIR, 'agentes.json');
const VISITAS_FILE = path.join(DATA_DIR, 'visitas.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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

function registrarAgente({ nombre, email, password }) {
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
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
const RMX_PAGINAS_MAX = 40; // 20 avisos/página → techo de 800 avisos, sobre el máximo real visto (730)

function urlRemax(req, pagina, minUsd, maxUsd) {
  const p = new URLSearchParams();
  p.set('city_id', String(RMX_CITY_SC));
  (RMX_SUB[req.tipo] || []).forEach((id) => p.append('subtype_property_ids[]', String(id)));
  if (minUsd) p.set('min_price', String(minUsd));
  if (maxUsd) p.set('max_price', String(maxUsd));
  p.set('page', String(pagina));
  return 'https://remax.bo/api/search?' + p.toString();
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
  return items.filter((i) => i.transaction_type_id == null || i.transaction_type_id === opId);
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
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function normalizarBienInmuebles(r, tc, tipo) {
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
    if (!Array.isArray(d)) {
      // En la página 1 esto significa que la fuente entera falló (ej. el
      // bloqueo anti-bot de Imunify360 del 2026-07-19) — hay que avisarlo,
      // no devolver una lista vacía como si simplemente no hubiera avisos.
      if (p === 1) throw new Error((d && d.message) || 'Respuesta inesperada de BienInmuebles');
      break; // páginas siguientes: si fallan, nos quedamos con lo ya traído
    }
    items.push(...d.map((r) => normalizarBienInmuebles(r, tc, req.tipo)));
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
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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

    // Lo que estaba cacheado pero ya NO aparece en el sitemap actual se sacó
    // de mobiliario.app (vendido, dado de baja) — sin esto, propiedades ya
    // no disponibles se quedarían mostrándose para siempre. El sitemap que
    // se pidió arriba es la lista completa vigente, así que cualquier id que
    // no esté ahí ya no existe del lado de ellos.
    const idsVigentes = new Set(sitemap.map((s) => s.id));
    for (const id of Object.keys(porId)) {
      if (!idsVigentes.has(id)) delete porId[id];
    }
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
  if (tipoM) {
    const t = tipoM[1].trim().toLowerCase();
    if (t.includes('depart')) campos.tipo = 'departamento';
    else if (t.includes('terreno')) campos.tipo = 'terreno';
    else if (t.includes('oficina')) campos.tipo = 'oficina';
    else if (t.includes('local')) campos.tipo = 'local';
    else if (t.includes('casa')) campos.tipo = 'casa';
  }
  if (zonaM) campos.zona = zonaM[1].trim();
  if (presM) {
    const numeros = presM[1].match(/[\d.,]+/g);
    if (numeros) campos.precioMax = numeros[numeros.length - 1].replace(/[.,]/g, '');
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
            porContactId.set(c.id, {
              ...camposRequerimiento({
                cliente: c.contactName || c.firstName || 'Lead de GHL',
                telefono: c.phone || '',
                operacion: 'venta',
                ...parseado,
              }),
              id: existente ? existente.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              creado: existente ? existente.creado : new Date().toISOString(),
              enviados: existente ? existente.enviados || [] : [],
              comentarios: existente ? existente.comentarios || [] : [],
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
  return items.map((it) => ({
    ...it,
    precio: it.precioCrudo == null ? null : it.monedaCrudo === 'bob' ? Math.round(it.precioCrudo / tc) : it.precioCrudo,
  }));
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

// ---------- Búsqueda combinada ----------

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

  // Tolerancia de precio: un aviso apenas fuera del presupuesto (ej. 8% más
  // caro) sigue siendo útil para el agente — se incluye pero marcado como
  // "cerca del presupuesto" en vez de perderse por un corte 100% duro.
  const MARGEN_PRECIO = 0.12;
  const precioMinConMargen = precioMinUsd ? Math.round(precioMinUsd * (1 - MARGEN_PRECIO)) : null;
  const precioMaxConMargen = precioMaxUsd ? Math.round(precioMaxUsd * (1 + MARGEN_PRECIO)) : null;
  // Recalculado acá (además de adentro de matcheaPropiedad) solo para el
  // objeto de retorno que usa la UI — el filtrado real ya lo aplica
  // matcheaPropiedad por su cuenta con este mismo criterio.
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

  const [c21, remax, bien, mobiliario] = await Promise.all([
    fetchConEstado('Century 21', fetchC21(req)),
    // Se le pide a RE/MAX el rango con margen (su filtro corre en su propio
    // servidor); el recorte fino con margen real se hace acá abajo.
    fetchConEstado('RE/MAX', fetchRemax(req, precioMinConMargen, precioMaxConMargen)),
    fetchConEstado('BienInmuebles', fetchBienInmuebles(req, tc)),
    fetchConEstado('Mobiliario App', fetchMobiliario(req, tc)),
  ]);

  let items = [...c21, ...remax, ...bien, ...mobiliario];

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
  items.sort(
    (a, b) =>
      Number(b.destaca) - Number(a.destaca) ||
      Number(a.cercaPresupuesto) - Number(b.cercaPresupuesto) ||
      (a.precio ?? 1e12) - (b.precio ?? 1e12)
  );

  const porFuente = { 'Century 21': 0, 'RE/MAX': 0, BienInmuebles: 0, 'Mobiliario App': 0 };
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
const PESO_FUENTE = { 'Century 21': 1.15, 'RE/MAX': 1.15, BienInmuebles: 0.9, 'Mobiliario App': 0.9 };
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

  const requiereAuth = modoMultiagente();
  const agente = autenticar(req);

  // Estado de sesión: lo consulta la interfaz para saber si hace falta pedir
  // una key y, si ya hay una válida, de qué agente se trata. Siempre responde,
  // incluso sin key, para poder mostrar la pantalla de acceso.
  if (url.pathname === '/api/whoami' && req.method === 'GET') {
    return json(res, 200, {
      requiereAuth,
      agente: agente ? { id: agente.id, nombre: agente.nombre, trial: estadoTrial(agente), telefonoContacto: agente.telefonoContacto || '', driveRaizUrl: agente.driveRaizUrl || '' } : null,
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

    if (url.pathname === '/api/admin/agentes' && req.method === 'GET') {
      const agentesConDatos = leerAgentes().map((a) => ({
        id: a.id,
        nombre: a.nombre,
        email: a.email || null,
        origen: a.email ? 'cuenta propia' : 'clave por CLI',
        creado: a.creado,
        activo: a.activo !== false,
        cantidadRequerimientos: leerRequerimientos(a.id).length,
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
      agente.ghlConfig = {
        locationId: body.locationId.trim(),
        token: body.token.trim(),
        requerimientoFieldId: body.requerimientoFieldId.trim(),
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
      agente: { nombre: agenteVitrina.nombre, telefonoContacto: agenteVitrina.telefonoContacto || '' },
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
    const actualizado = { ...lista[idx], ...camposRequerimiento(body) };
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
    if (body.driveRaizUrl !== undefined) actualizado.driveRaizUrl = String(body.driveRaizUrl).trim();
    lista[idx] = actualizado;
    guardarAgentes(lista);
    return json(res, 200, { ok: true, telefonoContacto: actualizado.telefonoContacto || '', driveRaizUrl: actualizado.driveRaizUrl || '' });
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
    const actualizado = { ...lista[idx], ...camposInventario(body) };
    if (actualizado.precio !== lista[idx].precio) {
      actualizado.historialPrecios = [...(lista[idx].historialPrecios || []), { precio: actualizado.precio, fecha: new Date().toISOString() }];
    }
    if (actualizado.fotosCarpetaDrive) actualizado.fotos = await resolverFotosDrive(actualizado.fotosCarpetaDrive);
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
  if (!cache.enProgreso && horasDesdeUltimaSync >= MOBILIARIO_RESYNC_HORAS) {
    console.log('Sincronizando Mobiliario App en segundo plano…');
    sincronizarMobiliario().catch((e) => console.error('Error sincronizando Mobiliario App:', e));
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

  // Mismo patrón para los requerimientos de GHL — no hace nada si
  // GHL_LOCATIONS no está configurado (ver leerLocationsGHL).
  chequearResyncRequerimientosGHL();
  setInterval(chequearResyncRequerimientosGHL, 60 * 60 * 1000);

  // Reconfirmar disponibilidad del inventario — no necesita frecuencia de
  // hora en hora, se revisa una vez por día.
  chequearReconfirmarInventario();
  setInterval(chequearReconfirmarInventario, 24 * 60 * 60 * 1000);
});
