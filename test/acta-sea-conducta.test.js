const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const front = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('las actas SEA se ofrecen únicamente desde el módulo de Conducta', () => {
  assert.match(front, /id="btn-imprimir-seccion-cond"[\s\S]{0,220}Imprimir Acta SEA/);
  assert.match(front, /imprimirInformeSeccionConducta\('I Período'\)/);
  assert.match(front, /imprimirInformeSeccionConducta\('II Período'\)/);
  assert.match(front, /imprimirInformeSeccionConducta\('anual'\)/);
  assert.match(front, /async function imprimirPDFActaSEAConducta/);
});

test('el formato reproduce los campos y columnas oficiales del SEA', () => {
  for (const texto of [
    'Dirección Regional de Educación:',
    'Circuito escolar:',
    'Centro educativo:',
    'Curso lectivo:',
    'Docente:',
    "['Asignatura:','Conducta']",
    'Nivel:',
    'Sección:',
    'Período:',
    "pdf.text('Acta'",
    "pdf.text('Identificación'",
    "pdf.text('Estudiante'",
    "pdf.text('Nota obtenida'",
    "pdf.text('Nombre y firma de docente'",
  ]) assert.ok(front.includes(texto), `Falta el texto oficial: ${texto}`);
});

test('el acta anual respeta el resultado definitivo de TES y no altera las actas académicas', () => {
  const inicio = front.indexOf('async function imprimirInformeSeccionConducta');
  const fin = front.indexOf('// ════════════════════════════════════\n//  ENCABEZADO MEP', inicio);
  const bloque = front.slice(inicio, fin);
  assert.match(bloque, /resultado-tes\?anio=/);
  assert.match(bloque, /tes\?\.nota_final_conducta != null/);
  assert.match(bloque, /new JsPDF\(\{unit:'mm',format:'letter'/);
  assert.doesNotMatch(bloque, /encabezadoMEP\(/);
  assert.match(front, /function prom_imprimirActa\(/);
});

