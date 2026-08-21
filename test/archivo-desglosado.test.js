const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const db=read('db.js');
const estudiantes=read('routes/estudiantes.js');
const expediente=read('routes/expediente.js');
const calificaciones=read('routes/calificaciones.js');
const matricula=read('routes/matricula.js');
const frontend=read('public/index.html');
const conducta=read('utils/archivo-conducta.js');

test('al archivar se conserva el promedio por rubro solo para períodos con datos',()=>{
  assert.match(calificaciones,/estudianteForzadoId=null/);
  assert.match(calificaciones,/\$3::int IS NOT NULL AND e\.id = \$3/);
  assert.match(calificaciones,/calcularPromedioEstudianteArchivado/);
  assert.match(estudiantes,/promedioArchivadoTieneDatos/);
  assert.match(estudiantes,/for\(const periodo of \["I Período","II Período"\]\)/);
  assert.match(estudiantes,/INSERT INTO expediente_academico/);
  assert.ok(estudiantes.indexOf('archivarResumenAcademicoEstudiante(est,anioArchivo)')<estudiantes.indexOf('// Archivar — mantener activo=true'));
});

test('cada boleta se conserva antes del retiro individual y del cierre anual',()=>{
  assert.match(db,/CREATE TABLE IF NOT EXISTS expediente_conducta_detalle/);
  assert.match(db,/UNIQUE\(estudiante_id, boleta_origen_id\)/);
  assert.match(conducta,/INSERT INTO expediente_conducta_detalle/);
  assert.match(conducta,/infraccion_descripcion,observacion,materia_nombre,responsable_nombre,registrado_por_nombre/);
  assert.match(estudiantes,/archivarConductaDetallada\(pool,\{estudianteId:est\.id,anio:anioArchivo\}\)/);
  assert.ok(matricula.indexOf('archivarConductaDetallada(client,{anio:anioAnt})')<matricula.indexOf('DELETE FROM boletas_conducta'));
});

test('el cierre anual rescata también a estudiantes archivados con notas parciales',()=>{
  assert.match(calificaciones,/calcularPromediosParaArchivo = async function\(client, profesor_id, seccion_id, materia_id, subgrupo, periodo, estudianteId = null\)/);
  assert.match(matricula,/const archivadosPreviosR = await client\.query/);
  assert.match(matricula,/JOIN secciones s ON s\.nombre = e\.seccion_archivo/);
  assert.match(matricula,/a\.subgrupo, periodo, estudiante\.id/);
  assert.match(matricula,/if\(!tieneDatos\) continue/);
});

test('el Archivo muestra promedios y conducta desglosados por los períodos existentes',()=>{
  assert.match(expediente,/\/:id\/historial-academico/);
  assert.match(expediente,/promedioTieneDatos/);
  assert.match(expediente,/\/:id\/conducta-desglosada/);
  assert.match(expediente,/solo_resumen/);
  assert.match(frontend,/Promedios desglosados por período/);
  assert.match(frontend,/Conducta desglosada por período/);
  assert.match(frontend,/No hay calificaciones cargadas para mostrar/);
  assert.match(frontend,/No hay boletas de conducta registradas/);
  assert.match(frontend,/conducta-desglosada/);
});
