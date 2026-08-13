const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('solo el administrador principal 0000000000 puede eliminar usuarios', () => {
  const admin = read('routes/admin.js');
  const ui = read('public/index.html');
  assert.match(admin, /function onlyAdmin000/);
  assert.match(admin, /u\?\.rol==="admin" && cedula==="0000000000"/);
  assert.match(admin, /router\.delete\("\/usuarios\/:id", onlyAdmin000/);
  assert.match(ui, /const puedeEliminar=ME\?\.rol==="admin"[\s\S]{0,120}==="0000000000"/);
  assert.match(ui, /onclick="eliminarUsuario\(/);
});

test('la eliminación es una baja segura y conserva el historial', () => {
  const db = read('db.js');
  const admin = read('routes/admin.js');
  assert.match(db, /ADD COLUMN IF NOT EXISTS eliminado BOOLEAN NOT NULL DEFAULT false/);
  assert.match(admin, /SET activo=false,eliminado=true,eliminado_at=NOW\(\),eliminado_por=\$2/);
  assert.match(admin, /UPDATE asignaciones SET activa=false/);
  assert.match(admin, /DELETE FROM funciones_institucionales WHERE usuario_id=\$1/);
  assert.match(admin, /DELETE FROM "session"/);
  assert.doesNotMatch(admin, /DELETE FROM usuarios WHERE id/);
  assert.match(admin, /no puede eliminar su propia cuenta/);
});
