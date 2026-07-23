// CLI para gestionar las keys de acceso de los agentes.
//
// Uso:
//   node scripts/agentes.js crear "Nombre del agente"
//   node scripts/agentes.js listar
//   node scripts/agentes.js revocar <id>
//   node scripts/agentes.js activar <id>
//
// Sin ningún agente creado, la app corre en modo abierto (sin key, como hasta
// ahora). Apenas creás el primero, la app exige X-Api-Key en todo /api/*.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVO = path.join(__dirname, '..', 'data', 'agentes.json');

function leer() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  } catch {
    return [];
  }
}

function guardar(lista) {
  fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
  fs.writeFileSync(ARCHIVO, JSON.stringify(lista, null, 2));
}

const [, , cmd, ...args] = process.argv;

if (cmd === 'crear') {
  const nombre = args.join(' ').trim();
  if (!nombre) {
    console.error('Uso: node scripts/agentes.js crear "Nombre del agente"');
    process.exit(1);
  }
  const lista = leer();
  const nuevo = {
    id: crypto.randomBytes(4).toString('hex'),
    nombre,
    apiKey: 'sof_' + crypto.randomBytes(24).toString('hex'),
    creado: new Date().toISOString(),
    activo: true,
  };
  lista.push(nuevo);
  guardar(lista);
  console.log('Agente creado: ' + nombre);
  console.log('Key: ' + nuevo.apiKey);
  console.log('');
  console.log('Link para GHL (Custom Menu Link) o para compartir directo:');
  console.log('  https://TU-DOMINIO/?key=' + nuevo.apiKey);
} else if (cmd === 'listar') {
  const lista = leer();
  if (!lista.length) {
    console.log('No hay agentes registrados todavía — la app corre en modo abierto (sin key).');
  } else {
    lista.forEach((a) => {
      console.log((a.activo === false ? '[revocado] ' : '[activo]   ') + a.nombre + '  —  id: ' + a.id);
      console.log('  key: ' + a.apiKey);
    });
  }
} else if (cmd === 'revocar') {
  const id = args[0];
  const lista = leer();
  const a = lista.find((x) => x.id === id);
  if (!a) {
    console.error('No existe un agente con id "' + id + '". Usá "listar" para ver los ids.');
    process.exit(1);
  }
  a.activo = false;
  guardar(lista);
  console.log('Revocado: ' + a.nombre);
} else if (cmd === 'activar') {
  const id = args[0];
  const lista = leer();
  const a = lista.find((x) => x.id === id);
  if (!a) {
    console.error('No existe un agente con id "' + id + '".');
    process.exit(1);
  }
  a.activo = true;
  guardar(lista);
  console.log('Reactivado: ' + a.nombre);
} else {
  console.log('Uso:');
  console.log('  node scripts/agentes.js crear "Nombre del agente"');
  console.log('  node scripts/agentes.js listar');
  console.log('  node scripts/agentes.js revocar <id>');
  console.log('  node scripts/agentes.js activar <id>');
}
