const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
const agenda = fs.readFileSync(path.join(raiz, 'routes', 'agenda.js'), 'utf8');

test('Orientación puede registrar un compromiso propio sin invitados', () => {
  assert.match(html, /id="agenda-btn-compromiso"/);
  assert.match(html, /tieneAlgunRol\('orientador'\)/);
  assert.match(html, /agendaEsCompromisoPropio\?\[\]:\[\.\.\.agendaSeleccionados\]/);
  assert.match(html, /compromiso_propio:agendaEsCompromisoPropio/);
  assert.match(html, /Guardar y bloquear horario/);
});

test('el servidor permite compromisos propios a Orientación y Administración y los confirma', () => {
  assert.match(agenda, /compromisoPropio=req\.body\.compromiso_propio===true/);
  assert.match(agenda, /compromisoPropio && !esOrientador\(u\) && !esAdmin\(u\)/);
  assert.match(agenda, /compromisoPropio && participantes\.length/);
  assert.match(agenda, /confirmado\?'aceptado':'pendiente'/);
});

test('los eventos propios participan en la detección de choques de horario', () => {
  assert.match(agenda, /JOIN agenda_participantes p ON p\.evento_id=e\.id/);
  assert.match(agenda, /p\.usuario_id=\$1 AND p\.estado<>'rechazado'/);
  assert.match(agenda, /compromisoExistente\(pool,p\.id,fecha,inicio,fin\)/);
});
