const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const raiz=path.join(__dirname,'..');
const leer=archivo=>fs.readFileSync(path.join(raiz,archivo),'utf8');

test('guardar un horario evita concurrencia, duplicados e inserciones individuales',()=>{
  const ruta=leer('routes/horarios.js');
  assert.match(ruta,/pg_advisory_xact_lock\(\$1,\$2\)/);
  assert.match(ruta,/const vistas=new Set\(\)/);
  assert.match(ruta,/jsonb_to_recordset\(\$3::jsonb\)/);
  assert.match(ruta,/celdas_guardadas:normalizadas\.length/);
});

test('el botón Guardar horario impide un segundo envío mientras procesa',()=>{
  const ui=leer('public/index.html');
  assert.match(ui,/btn\?\.dataset\.guardando==='1'/);
  assert.match(ui,/btn\.disabled=true/);
  assert.match(ui,/finally\{if\(btn\)\{btn\.dataset\.guardando='0';btn\.disabled=false/);
});

test('los bloques del horario docente también impiden doble guardado y traducen conflictos',()=>{
  const ruta=leer('routes/horarios.js'),ui=leer('public/index.html');
  assert.match(ui,/async function horGuardarBloque\(\)[\s\S]*btn\?\.dataset\.guardando==='1'/);
  assert.match(ui,/btn\.textContent='⏳ Guardando\.\.\.'/);
  assert.match(ruta,/router\.put\("\/bloques\/:id"[\s\S]*e\.code==='23505'/);
});

test('el despliegue elimina guiones de las cédulas estudiantiles y evita que regresen',()=>{
  const db=leer('db.js');
  assert.match(db,/UPDATE estudiantes e[\s\S]*SET cedula=BTRIM\(REPLACE\(e\.cedula,'-',''\)\)/);
  assert.match(db,/normalizar_cedula_estudiante_fn/);
  assert.match(db,/BEFORE INSERT OR UPDATE OF cedula ON estudiantes/);
  assert.match(db,/no modificadas por posible duplicado/);
});
