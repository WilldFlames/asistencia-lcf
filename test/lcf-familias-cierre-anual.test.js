const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('LCF Familias lista de inmediato todas las cuentas con servicio activo',()=>{
  const rutas=read('routes/admin.js'),ui=read('public/index.html');
  assert.match(rutas,/const soloActivos = req\.query\.activos === "1"/);
  assert.match(rutas,/WHERE pa\.servicio_habilitado=true/);
  assert.match(rutas,/habilitado_por_nombre/);
  assert.match(ui,/await gpBuscar\(true\)/);
  assert.match(ui,/gp-resumen-activos/);
  assert.match(ui,/servicio_habilitado_at/);
});

test('la desactivación anual cierra sesiones sin borrar cuentas ni historial',()=>{
  const db=read('db.js'),rutas=read('routes/admin.js'),ui=read('public/index.html');
  assert.match(db,/servicio_deshabilitado_at TIMESTAMP/);
  assert.match(db,/servicio_deshabilitado_por INTEGER REFERENCES usuarios/);
  assert.match(rutas,/router\.put\("\/padres\/servicio\/desactivar-todos"/);
  assert.match(rutas,/SET servicio_habilitado=false,sid_activo=NULL/);
  assert.doesNotMatch(rutas,/padres\/servicio\/desactivar-todos[\s\S]{0,500}DELETE FROM padres_acceso/);
  assert.match(ui,/CIERRE ANUAL DE LCF FAMILIAS/);
  assert.match(ui,/No se borrarán cuentas, contraseñas, estudiantes ni historial/);
});
