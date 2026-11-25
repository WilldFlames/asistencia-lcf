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

test('la lista general respeta la asignación A/B o imprime la sección completa',async()=>{
  const vm=require('node:vm');
  const campos={'fle-tipo':{value:'general'},'fle-materia':{value:'12'},'filtro-seccion-est':{value:'3'}};
  const a={id:12,seccion_id:3,subgrupo:'B'};
  const filas=[
    {id:1,seccion_id:3,subgrupo:'A'},
    {id:2,seccion_id:3,subgrupo:' b '},
    {id:3,seccion_id:3,subgrupo:null},
    {id:4,seccion_id:4,subgrupo:'B'}
  ];
  const impresiones=[];
  const entorno={
    document:{getElementById:id=>campos[id]},formatosListaAsignaciones:[a],
    api:async ruta=>{assert.equal(ruta,'/api/estudiantes?seccion_id=3');return filas;},
    ordenarEstudiantes:lista=>lista,cerrarModal:()=>{},
    imprimirListaEstudiantes:(lista,asignacion)=>impresiones.push({lista,asignacion})
  };
  for(const nombre of ['generarFormatoListaEstudiantes','cargarFilasListaImpresion']){
    vm.runInNewContext(html.match(new RegExp(`async function ${nombre}\\([^\\n]*\\n[\\s\\S]*?\\n\\}`))[0],entorno);
  }
  await entorno.generarFormatoListaEstudiantes();
  assert.equal(Array.from(impresiones[0].lista,e=>e.id).join(','),'2');
  a.subgrupo='A';
  await entorno.generarFormatoListaEstudiantes();
  assert.equal(Array.from(impresiones[1].lista,e=>e.id).join(','),'1');
  campos['fle-materia'].value='';
  await entorno.generarFormatoListaEstudiantes();
  assert.equal(Array.from(impresiones[2].lista,e=>e.id).join(','),'1,2,3');
});

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

test('Portería imprime entrada salida y permiso por estudiante y rango',()=>{
  assert.match(html,/function ptImprimirInforme/);
  assert.match(html,/INFORME DE PORTERÍA/);
  assert.match(html,/Permiso de salida N°/);
  assert.match(html,/pt-inf-seccion/);
  assert.match(html,/pt-inf-estudiante/);
  assert.match(html,/pt-inf-desde/);
  assert.match(html,/pt-inf-hasta/);
  assert.match(porteria,/const canInforme\s*= requireRol\("admin","auxiliar","administrativo","profesor_guia","orientador"\)/);
  assert.match(porteria,/router\.get\("\/informe-diario", canInforme/);
  assert.match(html,/\['admin','auxiliar','administrativo','profesor_guia','orientador'\]\.includes\(ME\.rol\)/);
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

test('traslado y resolución guardan e imprimen el período exacto de la sanción',()=>{
  assert.match(html,/Período al que corresponden el rebajo y la sanción/);
  assert.match(html,/traslado\.periodo_conducta/);
  assert.match(html,/const periodoConducta = c\.periodo_conducta \|\| c\.semestre/);
  assert.doesNotMatch(html,/en el \$\{c\.semestre\|\|'____'\} semestre/);
  assert.match(procesos,/Seleccione si el rebajo y la sanción corresponden al I o II Período/);
  assert.match(procesos,/traslado\.periodo_conducta\|\|traslado\.semestre/);
  assert.match(procesos,/periodo_conducta=EXCLUDED\.periodo_conducta/);
  assert.match(procesos,/\^\(ii\|2\|segundo\).*\?['"]II Período['"]/s);
  assert.match(db,/ALTER TABLE boletas_conducta ADD COLUMN IF NOT EXISTS periodo_conducta TEXT/);
  assert.match(db,/ALTER TABLE medidas_estudiantiles ADD COLUMN IF NOT EXISTS periodo_conducta TEXT/);
  assert.match(db,/WITH periodos_dp AS/);
  assert.match(db,/WHERE b\.debido_proceso_id=pd\.proceso_id AND pd\.periodo IS NOT NULL/);
});
