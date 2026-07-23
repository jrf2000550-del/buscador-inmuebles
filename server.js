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

const TIPOS = new Set(['casa', 'departamento', 'terreno', 'local', 'oficina']);
const APLICA_DORMITORIOS = new Set(['casa', 'departamento']);

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

// ---------- Utilidades de precio / zona ----------

// Acepta "65.000", "65,000" o "65000" y devuelve 65000 (entero).
function parsePrecio(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
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
const C21_TIPO = {
  casa: 'tipo_casa-o-casa-en-condominio',
  departamento: 'tipo_departamento-o-penthouse',
  terreno: 'tipo_terreno',
  local: 'tipo_local',
  oficina: 'tipo_oficinas',
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
    m2Terreno: Number(r.m2TFormat) || null,
    m2Construccion: Number(r.m2CFormat) || null,
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

const RMX_SUB = {
  casa: [161, 42, 228],
  departamento: [131, 174, 140],
  terreno: [101],
  local: [1, 55],
  oficina: [1],
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

const BIEN_TIPO = { casa: 1, departamento: 2, terreno: 3, oficina: 4, local: 5 };
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

function normalizarBienInmuebles(r, tc) {
  const enBs = String(r.moneda_cata) === '1';
  const crudo = Number(String(r.precio_cata || '').replace(/[^\d.]/g, ''));
  let precio = crudo ? Math.round(enBs ? crudo / tc : crudo) : null;
  const dormitorios = Number(r.habitacion_cata);
  const banos = Number(r.banio_cata);
  return {
    fuente: 'BienInmuebles',
    titulo: r.nomb_cata || '(sin título)',
    precio,
    dormitorios: dormitorios > 0 ? dormitorios : null,
    banos: banos > 0 ? banos : null,
    m2Terreno: Number(r.supterreno_cata) || null,
    m2Construccion: null,
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
    items.push(...d.map((r) => normalizarBienInmuebles(r, tc)));
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
const MOBILIARIO_RESYNC_HORAS = 20; // a partir de esta antigüedad, se reintenta sincronizar

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
function categoriaDesdeBreadcrumb(breadcrumbJson) {
  const cat = breadcrumbJson?.itemListElement?.[1]?.name || '';
  const operacion = /alquiler/i.test(cat) ? 'alquiler' : 'venta';
  let tipo = null;
  if (/casas?/i.test(cat)) tipo = 'casa';
  else if (/departamentos?/i.test(cat)) tipo = 'departamento';
  else if (/terrenos?/i.test(cat)) tipo = 'terreno';
  else if (/locales?/i.test(cat)) tipo = 'local';
  else if (/oficinas?/i.test(cat)) tipo = 'oficina';
  return { operacion, tipo, categoriaTexto: cat };
}

function normalizarMobiliario(entidad, breadcrumbJson, url) {
  const { operacion, tipo, categoriaTexto } = categoriaDesdeBreadcrumb(breadcrumbJson);
  if (!tipo) return null; // categoría no reconocida (ej. otro tipo de propiedad) — se descarta
  const m2 = entidad.floorSize?.value ? Math.round(Number(entidad.floorSize.value)) : null;
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
    // Además de lo nuevo/modificado, re-procesa lo que quedó en el formato
    // viejo (antes de guardar precioCrudo/monedaCrudo por separado, bug de
    // conversión de moneda corregido 2026-07-23) — así una sola sincronización
    // arregla sola los datos ya cacheados, sin tener que borrar nada a mano.
    const pendientes = sitemap.filter(
      (s) => !porId[s.id] || porId[s.id].lastmod !== s.lastmod || (porId[s.id].item && porId[s.id].item.precioCrudo === undefined)
    );

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
        if (r.item) porId[r.id] = { lastmod: r.lastmod, item: r.item };
        else if (r.item === null) porId[r.id] = { lastmod: r.lastmod, item: null }; // descartado (otra ciudad/categoría) — no reintentar
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
    cache.sincronizadoEn = new Date().toISOString();
  } catch (e) {
    cache.ultimoError = 'No se pudo sincronizar: ' + e.message;
  } finally {
    cache.enProgreso = false;
    guardarCacheMobiliario(cache);
    sincronizandoMobiliario = false;
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
  const porFuenteBruto = {
    'Century 21': c21.length,
    'RE/MAX': remax.length,
    BienInmuebles: bien.length,
    'Mobiliario App': mobiliario.length,
  };

  // Filtro de zona: el aviso debe coincidir con alguna de las zonas pedidas
  if (zonas.length) {
    items = items.filter((i) => zonas.some((z) => zonaMatch(i, z)));
  }
  // Precio en US$ (si el aviso no declara precio, no pasa). Dentro del rango
  // exacto pasa directo; entre el rango exacto y el margen queda marcado
  // "cercaPresupuesto" (se muestra igual, pero se avisa y se ordena después).
  if (precioMinConMargen) items = items.filter((i) => i.precio != null && i.precio >= precioMinConMargen);
  if (precioMaxConMargen) items = items.filter((i) => i.precio != null && i.precio <= precioMaxConMargen);
  for (const i of items) {
    i.cercaPresupuesto =
      i.precio != null &&
      ((precioMinUsd != null && i.precio < precioMinUsd) || (precioMaxUsd != null && i.precio > precioMaxUsd));
  }
  // Dormitorios (solo casa/departamento)
  if (req.dormitorios && APLICA_DORMITORIOS.has(req.tipo))
    items = items.filter((i) => i.dormitorios != null && i.dormitorios >= Number(req.dormitorios));
  // Baños (mínimo)
  if (req.banos)
    items = items.filter((i) => i.banos != null && i.banos >= Number(req.banos));
  // Medidas: m² de terreno y de construcción (mín/máx). Si el aviso no declara la
  // medida, no pasa el filtro correspondiente.
  const mtMin = parsePrecio(req.m2TerrenoMin);
  const mtMax = parsePrecio(req.m2TerrenoMax);
  const mcMin = parsePrecio(req.m2ConstruccionMin);
  const mcMax = parsePrecio(req.m2ConstruccionMax);
  if (mtMin) items = items.filter((i) => i.m2Terreno != null && i.m2Terreno >= mtMin);
  if (mtMax) items = items.filter((i) => i.m2Terreno != null && i.m2Terreno <= mtMax);
  if (mcMin) items = items.filter((i) => i.m2Construccion != null && i.m2Construccion >= mcMin);
  if (mcMax) items = items.filter((i) => i.m2Construccion != null && i.m2Construccion <= mcMax);

  // Antigüedad: descarta avisos más viejos que el límite pedido. Si NO se
  // conoce la fecha del aviso (ej. BienInmuebles no la expone), se deja pasar
  // en vez de descartarlo — lo contrario borraría en silencio el 100% de las
  // fuentes sin fecha (bug corregido 2026-07-19, mismo patrón que el umbral
  // de alquileres: "no se sabe" no debería significar "se descarta").
  const antiguedadMaxDias = req.antiguedadMaxDias ? Number(req.antiguedadMaxDias) : null;
  if (antiguedadMaxDias) {
    const corte = Date.now() - antiguedadMaxDias * 24 * 60 * 60 * 1000;
    items = items.filter((i) => !i.fecha || new Date(i.fecha).getTime() >= corte);
  }

  // Excluir: descarta lo que el cliente no quiere (ej. "condominio" cuando
  // pidió "fuera de condominio"). Sin tildes de los dos lados, mismo criterio
  // que zonaMatch — "área" tiene que encontrar "area" y viceversa.
  if (excluir.length) {
    items = items.filter((i) => !excluir.some((p) => quitarAcentos(textoItem(i)).includes(quitarAcentos(p))));
  }

  // Palabras clave: por defecto solo ordenan (los que las mencionan salen
  // primero). Con filtroEstricto=1 además descartan lo que no las menciona
  // — puede dar pocos o cero resultados si el aviso no usa esa palabra.
  for (const i of items) i.destaca = destacar.some((p) => quitarAcentos(textoItem(i)).includes(quitarAcentos(p)));
  if (destacar.length && req.filtroEstricto === '1') {
    items = items.filter((i) => i.destaca);
  }
  items.sort(
    (a, b) =>
      Number(b.destaca) - Number(a.destaca) ||
      Number(a.cercaPresupuesto) - Number(b.cercaPresupuesto) ||
      (a.precio ?? 1e12) - (b.precio ?? 1e12)
  );

  const porFuente = { 'Century 21': 0, 'RE/MAX': 0, BienInmuebles: 0, 'Mobiliario App': 0 };
  for (const i of items) porFuente[i.fuente] = (porFuente[i.fuente] || 0) + 1;
  const cantidadCerca = items.filter((i) => i.cercaPresupuesto).length;

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
    analisisMercado: calcularEstadisticasMercado(items, req.tipo),
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
  return n % 2 !== 0 ? numsOrdenados[mitad] : Math.round((numsOrdenados[mitad - 1] + numsOrdenados[mitad]) / 2);
}

function calcularEstadisticasMercado(items, tipo) {
  const conPrecio = items.filter((i) => i.precio != null);
  if (!conPrecio.length) return null;
  const precios = conPrecio.map((i) => i.precio).sort((a, b) => a - b);

  // Terreno se compara por precio/m² de terreno; el resto (casa, depto,
  // local, oficina) por precio/m² construido.
  const campoM2 = tipo === 'terreno' ? 'm2Terreno' : 'm2Construccion';
  const conM2 = conPrecio.filter((i) => i[campoM2] > 0);
  let precioM2Promedio = null;
  let precioM2Mediana = null;
  if (conM2.length) {
    const preciosM2 = conM2.map((i) => i.precio / i[campoM2]).sort((a, b) => a - b);
    precioM2Promedio = Math.round(preciosM2.reduce((s, p) => s + p, 0) / preciosM2.length);
    precioM2Mediana = mediana(preciosM2);
  }

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
  };
}

const PROMPT_ACM =
  'Sos un tasador inmobiliario experto en Santa Cruz de la Sierra, Bolivia. Te paso los criterios de una ' +
  'propiedad (el "sujeto" del análisis), estadísticas de mercado y una muestra de comparables reales. Armá un ' +
  'Análisis Comparativo de Mercado (ACM) breve en español, sin emojis, con esta estructura en párrafos separados: ' +
  '1) Rango de valor de mercado sugerido — usá la MEDIANA de precio/m² como referencia central (es más confiable ' +
  'que el promedio si hay outliers), ajustá el rango según qué tan dispersos están los comparables; ' +
  '2) Mencioná 2-3 comparables específicos relevantes (por precio, tamaño o ubicación) y por qué importan para la ' +
  'referencia; ' +
  '3) Una frase final con una recomendación práctica (ej. precio de publicación sugerido, o qué conviene ' +
  'confirmar antes de dar un valor definitivo). Máximo 8 líneas en total. Sé honesto si hay pocos comparables o ' +
  'son poco representativos — no inventes precisión que no existe con los datos disponibles.';

function contextoACM(listados) {
  return listados.slice(0, 20).map((i) => ({
    fuente: i.fuente,
    precio: i.precio,
    zona: i.zona,
    dormitorios: i.dormitorios,
    banos: i.banos,
    m2Terreno: i.m2Terreno,
    m2Construccion: i.m2Construccion,
    titulo: i.titulo,
  }));
}

async function generarACM(req, listados, stats) {
  if (!stats) return null;
  const user =
    `Propiedad sujeto (criterios buscados):\n${JSON.stringify(req)}\n\n` +
    `Estadísticas de los comparables:\n${JSON.stringify(stats)}\n\n` +
    `Muestra de comparables:\n${JSON.stringify(contextoACM(listados))}`;
  const proveedor = estadoIA().proveedor;
  return proveedor === 'gemini' ? await llamarGemini(PROMPT_ACM, user, false) : await llamarClaude(PROMPT_ACM, user, null);
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
  'tipo (casa|departamento|terreno|local|oficina), zona, moneda (usd|bob), precioMin, precioMax, ' +
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
    tipo: { type: 'string', enum: ['casa', 'departamento', 'terreno', 'local', 'oficina'] },
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
      agente: agente ? { id: agente.id, nombre: agente.nombre } : null,
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

    if (url.pathname === '/api/admin/agentes' && req.method === 'GET') {
      const agentesConDatos = leerAgentes().map((a) => ({
        id: a.id,
        nombre: a.nombre,
        email: a.email || null,
        origen: a.email ? 'cuenta propia' : 'clave por CLI',
        creado: a.creado,
        activo: a.activo !== false,
        cantidadRequerimientos: leerRequerimientos(a.id).length,
      }));
      agentesConDatos.sort((x, y) => new Date(y.creado) - new Date(x.creado));
      return json(res, 200, agentesConDatos);
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

    return json(res, 404, { error: 'Ruta de administración no encontrada.' });
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
          resultado.analisisMercadoIA = await generarACM(params, resultado.listados, resultado.analisisMercado);
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

server.listen(PORT, () => {
  console.log(`Buscador de inmuebles corriendo en http://localhost:${PORT}`);

  // Sincronizar Mobiliario App en segundo plano si nunca se hizo o si ya
  // pasó bastante tiempo — no bloquea el arranque del servidor (fire and
  // forget). Si el servidor se reinicia a mitad de una sincronización
  // (pasa seguido en desarrollo), retoma solo lo que falte gracias al
  // progreso ya guardado en cache-mobiliario.json.
  const cacheInicial = leerCacheMobiliario();
  const horasDesdeUltimaSync = cacheInicial.sincronizadoEn
    ? (Date.now() - new Date(cacheInicial.sincronizadoEn).getTime()) / 3600000
    : Infinity;
  if (!cacheInicial.enProgreso && horasDesdeUltimaSync >= MOBILIARIO_RESYNC_HORAS) {
    console.log('Sincronizando Mobiliario App en segundo plano…');
    sincronizarMobiliario().catch((e) => console.error('Error sincronizando Mobiliario App:', e));
  }
});
