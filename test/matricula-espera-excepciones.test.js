const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes', 'matricula.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('el cambio anual conserva sin sección a quien no matriculó como pendiente, no como retirado', () => {
  assert.match(route, /'pendiente_matricula'/);
  assert.match(route, /seccion_origen_nombre/);
  assert.match(route, /UPDATE estudiantes SET seccion_id = NULL, matricula_completada=false/);
  assert.match(ui, /Pendientes de matrícula/);
});

test('los resultados informativos de 2026 nunca bloquean matrícula 2027', () => {
  assert.match(route, /\(anio-1\)>=2027/);
  assert.match(route, /\(a-1\)>=2027/);
  assert.match(route, /2026 fue expresamente un año informativo/);
});

test('la excepción de sección exige resolución de Dirección y no levanta el bloqueo individual', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS excepciones_restriccion_matricula/);
  assert.match(route, /Solo Dirección puede resolver esta excepción/);
  assert.match(route, /const bloqueo=await bloqueoPendiente\(estudianteId,anio\)/);
  assert.match(route, /MATRÍCULA RESTRINGIDA/);
  assert.match(route, /requiere_excepcion:true/);
});

test('la matrícula tardía activa únicamente al estudiante al asignarle sección', () => {
  assert.match(route, /matricula_tardia_at=CASE WHEN matricula\.estado='pendiente_matricula' THEN NOW\(\)/);
  assert.match(route, /UPDATE estudiantes SET seccion_id=\$1, matricula_completada=true/);
});

test('Idioma/Tecnología es la fuente oficial y la matrícula hereda A o B', () => {
  assert.match(route, /est_tecnologia \|\| historial\.rows\[0\]\?\.mat_tecnologia \|\| tecnologia/);
  assert.match(route, /Inglés Conversacional' THEN 'A'/);
  assert.match(route, /Diseño Publicitario','Matem\/AMPROSA'\) THEN 'B'/);
  assert.match(db, /UPDATE matricula SET subgrupo=CASE/);
});

test('ningún perfil puede superar trece estudiantes por grupo tecnológico', () => {
  assert.match(route, /if\(sub && ocupadosSub >= MAX_SUB\)\{/);
  assert.doesNotMatch(route, /if\(sub && ocupadosSub >= MAX_SUB && !\(forzar/);
  assert.match(route, /máximo obligatorio/);
  assert.match(ui, /Elección registrada en Idioma\/Tecnología/);
});
