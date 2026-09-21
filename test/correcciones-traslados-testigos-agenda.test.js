const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
const calificaciones = fs.readFileSync(path.join(raiz, 'routes', 'calificaciones.js'), 'utf8');
const procesos = fs.readFileSync(path.join(raiz, 'routes', 'debidosProcesos.js'), 'utf8');

test('el historial separa períodos y el I cerrado se recupera sin mezclar el II', () => {
  assert.match(html, /I y II Período/);
  assert.match(html, /m\.periodo === r\.periodo/);
  assert.match(calificaciones, /periodo === 'I Período'/);
  assert.match(calificaciones, /promedio_trasladado:true/);
  assert.match(calificaciones, /Number\(origen\.profesor_id\)/);
  assert.doesNotMatch(calificaciones, /WHERE ev\.profesor_id=\$2 AND ev\.materia_id/);
  assert.match(calificaciones, /El II Período nunca entra aquí ni se mezcla/);
});

test('cada testigo abre, guarda e imprime mediante el id real de su paso', () => {
  assert.match(html, /pasosById\[Number\(t\.paso_cita_id\)\]/);
  assert.match(html, /paso_id: dpPasoEnEdicion\.paso_id/);
  assert.match(procesos, /paso_id && !existente\.rows\.length/);
  assert.match(procesos, /MAX\(orden\)/);
});

test('aceptar una reunión actualiza agenda y notificaciones con funciones existentes', () => {
  const responder = html.match(/async function agendaResponder[\s\S]*?\}\}/)?.[0] || '';
  assert.match(responder, /await agendaCargar\(\)/);
  assert.match(responder, /verificarNotif\(\)/);
  assert.doesNotMatch(responder, /cargarNotificaciones/);
});
