const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const html=read('public/index.html');
const reportes=read('routes/reportes.js');
const estudiantes=read('routes/estudiantes.js');
const procesos=read('routes/debidosProcesos.js');
const pautas=read('routes/protocolos.js');
const porteria=read('routes/porteria.js');
const db=read('db.js');

test('Archivo identifica los debidos procesos del estudiante retirado',()=>{
  assert.match(estudiantes,/debidos_procesos_total/);
  assert.match(estudiantes,/debidos_procesos_resumen/);
  assert.match(html,/Debidos procesos registrados/);
});

test('cada docente consulta asistencia de sus secciones con presentes tardías y ausencias',()=>{
  assert.match(reportes,/seccionesPermitidas\(u\)/);
  assert.match(reportes,/FILTER \(WHERE a\.estado='P'\) AS presentes/);
  assert.match(html,/totalP/);
  assert.match(html,/lecc\. presentes/);
});

test('debidos procesos y pautas tienen listados PDF separados por consecutivo',()=>{
  assert.match(html,/function imprimirListadoDP/);
  assert.match(html,/LISTADO DE DEBIDOS PROCESOS/);
  assert.match(html,/function imprimirListadoPautas/);
  assert.match(html,/LISTADO DE PAUTAS/);
  assert.match(html,/Number\(a\.numero\)-Number\(b\.numero\)/);
});

test('los listados de debidos procesos y pautas imprimen el funcionario que los inició',()=>{
  assert.match(html,/>Inició</);
  assert.match(html,/nombreDesdeCampos\(x\.ini_nombre,x\.ini_ap1,x\.ini_ap2/);
  assert.match(procesos,/ini\.primer_apellido AS ini_ap1/);
  assert.match(pautas,/ini\.primer_apellido AS ini_ap1/);
});

test('los listados distinguen quién inició de quién completó o ejecutó',()=>{
  assert.match(html,/Completó \/ ejecutó/);
  assert.match(html,/nombreDesdeCampos\(x\.fin_nombre,x\.fin_ap1,x\.fin_ap2/);
  assert.match(procesos,/fin\.primer_apellido AS fin_ap1/);
  assert.match(procesos,/finalizado_por=\$2/);
  assert.match(pautas,/fin\.primer_apellido AS fin_ap1/);
  assert.match(pautas,/finalizado_por=\$2/);
  assert.match(db,/ALTER TABLE debidos_procesos ADD COLUMN IF NOT EXISTS finalizado_por/);
  assert.match(db,/ALTER TABLE protocolos ADD COLUMN IF NOT EXISTS finalizado_por/);
});

test('Portería imprime entrada salida y permiso para una fecha elegida',()=>{
  assert.match(html,/function ptImprimirInforme/);
  assert.match(html,/INFORME DIARIO DE PORTERÍA/);
  assert.match(html,/Permiso de salida N°/);
  assert.match(html,/pt-fecha/);
  assert.match(porteria,/informe-diario.*requireRol\("admin","administrativo"\)/s);
  assert.match(html,/\['admin','administrativo'\]\.includes\(ME\.rol\)/);
});

test('los listados históricos conservan estudiantes retirados',()=>{
  assert.match(procesos,/JOIN estudiantes e ON e\.id = dp\.estudiante_id/);
  assert.doesNotMatch(procesos,/JOIN estudiantes e ON e\.id = dp\.estudiante_id AND e\.activo=true/);
  assert.match(pautas,/protocolo_personas pp LEFT JOIN estudiantes e ON e\.id = pp\.estudiante_id/);
});

test('cerrar resolución aplica rebajo y suspensión natural una sola vez',()=>{
  assert.match(db,/debido_proceso_id/);
  assert.match(db,/uq_boleta_debido_proceso/);
  assert.match(db,/uq_suspension_debido_proceso/);
  assert.match(procesos,/INSERT INTO boletas_conducta/);
  assert.match(procesos,/INSERT INTO medidas_estudiantiles/);
  assert.match(procesos,/fecha_fin,observacion/);
  assert.match(procesos,/\$2::date \+ \(\$3::int-1\)/);
  assert.match(procesos,/await client\.query\("BEGIN"\)/);
  assert.match(html,/Período al que se rebajan los puntos/);
});
