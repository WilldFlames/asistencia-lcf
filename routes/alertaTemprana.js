const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const { llenarPlantillaAlerta } = require("../utils/excelAlertaTemprana");

const ESTADOS = ["activada","en_proceso","en_espera","cerrada","eliminada"];
const RESULTADOS = ["efectiva","no_contesta","equivocado","fuera_servicio","buzon","devolver_llamada","otro"];
const MEDIOS = ["telefono","videollamada","audio","otro"];
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

function enteroPositivo(valor){
  const numero=Number(valor);
  return Number.isSafeInteger(numero)&&numero>0?numero:null;
}
function fechaISOValida(valor,opcional=false){
  if(valor===null||valor===undefined||valor==="") return opcional;
  const texto=String(valor);
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if(!m) return false;
  const fecha=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));
  return fecha.getUTCFullYear()===Number(m[1])&&fecha.getUTCMonth()===Number(m[2])-1&&fecha.getUTCDate()===Number(m[3]);
}
function horaValida(valor,opcional=false){
  if(valor===null||valor===undefined||valor==="") return opcional;
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(valor));
}
function segundosHora(valor){
  const partes=String(valor||"").split(":").map(Number);
  return (partes[0]||0)*3600+(partes[1]||0)*60+(partes[2]||0);
}
function fechaDocumento(valor){
  if(!valor) return "";
  const texto=valor instanceof Date?valor.toISOString().slice(0,10):String(valor).slice(0,10);
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  return m?`${m[3]}/${m[2]}/${m[1]}`:"";
}

const CATALOGO = [
  ["Desempeño educativo",[
    [1,"Reincorporación al sistema educativo"],[2,"Repitencia o rezago en alguna asignatura"],
    [3,"Sobre edad según el nivel que cursa"],[4,"Traslados repetitivos durante el año"],
    [5,"Bajo rendimiento académico"],[6,"Conducta reprobada"],[7,"Rezago en lectoescritura"],
    [8,"Falta del servicio comunal estudiantil"],[9,"Suspensión"]]],
  ["Convivencia educativa",[
    [10,"Desmotivación"],[11,"Cambios repentinos en el estado de ánimo o la conducta"],[12,"Aislamiento"],
    [13,"Percepción de no aceptación por parte del personal docente"],[14,"Bullying o ciberbullying"],
    [15,"Bullying por condición LGTB"],[16,"Violencia física"],[17,"Violencia psicológica"],
    [18,"Delitos penados por ley cometidos por la persona estudiante"],[19,"Consumo de drogas en el centro educativo"],
    [20,"Tráfico de drogas u otro delito en el centro educativo"],[21,"Tenencia de drogas en el centro educativo"],
    [22,"Tenencia de armas en el centro educativo"],[23,"Uso de armas"],[24,"Xenofobia"],
    [25,"Discriminación racial"],[26,"Víctima de tiroteo o sicariato"]]],
  ["Condición económica",[
    [27,"Desempleo en el hogar"],[28,"Trabajo informal o temporal en el hogar"],[29,"Estudiante jefe o jefa de hogar"],
    [30,"Pobreza o pobreza extrema"],[31,"Sin transferencia monetaria condicionada"]]],
  ["Condición familiar",[
    [32,"Adicciones de las personas encargadas"],[33,"Baja escolarización de las personas encargadas"],
    [34,"Fallecimiento de la persona encargada"],[35,"Sin apoyo para el cuido infantil"],
    [36,"Negligencia en el apoyo educativo"],[37,"Negligencia en la atención integral"],[38,"Violencia intrafamiliar"]]],
  ["Riesgo social",[
    [39,"Embarazo en persona estudiante mayor de edad"],[40,"Relaciones impropias"],
    [41,"Persona estudiante menor de edad embarazada"],[42,"Madre o padre menor de edad"],
    [43,"Trabajo infantil o adolescente (referir al MTSS)"],[44,"Trata de personas"],
    [45,"Explotación sexual comercial"]]],
  ["Condición cultural",[
    [46,"Persona estudiante indígena"],[47,"Idioma"],[48,"Idioma o lengua en territorio indígena"],
    [49,"Persona migrante regular"],[50,"Persona migrante irregular"],[51,"Persona apátrida"],
    [52,"Riesgo de apatridia"],[53,"Riesgo de deportación de la persona estudiante o encargada"],
    [54,"Incompatibilidad entre la cultura y el sistema educativo"]]],
  ["Condición de acceso",[
    [55,"Falta de apoyos curriculares"],[56,"Falta de apoyos personales, organizativos, materiales o tecnológicos por discapacidad"],
    [57,"Falta de apoyos para alta dotación, talento o creatividad"],[58,"Falta de subsidio para alta dotación, talento o creatividad"],
    [59,"Ausencia de alimentación"],[60,"Ausencia de transporte"],[61,"Ausencia de ayudas técnicas por discapacidad"],
    [62,"Dificultad de acceso físico"],[63,"Dificultad de acceso tecnológico"]]],
  ["Condición de salud",[
    [64,"Ideación o tentativa de suicidio"],[65,"Lesiones autoinfligidas"],[66,"Trastornos alimenticios"],
    [67,"Condición de salud recurrente que requiere tratamiento"],[68,"Hospitalización o convalecencia"],
    [69,"Alergias medicamentosas, a vectores o alimentarias"],[70,"Afectación por desastre natural o antrópico"]]],
  ["Información confidencial",[
    [71,"Acoso u hostigamiento sexual"],[72,"Violación sexual"],[73,"Otras formas de violencia sexual"],
    [74,"Vinculación con banda delictiva"],[75,"Privación de libertad, libertad condicional o sanciones alternativas"],
    [76,"Persona refugiada"],[77,"Persona solicitante de refugio"]]]
].map(([categoria,items])=>({categoria,confidencial:categoria==="Información confidencial",items:items.map(([codigo,descripcion])=>({codigo,descripcion}))}));
const CODIGOS = new Set(CATALOGO.flatMap(g=>g.items.map(i=>i.codigo)));

function esDocente(u){
  return ["profesor","profesor_guia","orientador"].includes(u?.rol) ||
    (u?.funciones_extra||[]).some(f=>["profesor_guia","orientador"].includes(f));
}
async function puedeSupervisar(u){
  if(["admin","auxiliar","administrativo"].includes(u?.rol)) return true;
  if((u?.funciones_extra||[]).includes("coordinador")) return true;
  const q=await pool.query("SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='coordinador'",[u?.id||0]);
  return q.rows.length>0;
}
async function requireParticipante(req,res,next){
  try{
    if(esDocente(req.session.usuario) || await puedeSupervisar(req.session.usuario)) return next();
    return res.status(403).json({error:"Sin permiso para Alerta Temprana."});
  }catch(e){next(e);}
}
async function asignacionPropia(usuarioId,asignacionId,estudianteId=null){
  const asignacionNumero=enteroPositivo(asignacionId),usuarioNumero=enteroPositivo(usuarioId);
  const estudianteNumero=estudianteId===null?null:enteroPositivo(estudianteId);
  if(!asignacionNumero||!usuarioNumero||(estudianteId!==null&&!estudianteNumero)) return null;
  const anio=await obtenerAnioActivo();
  const params=[asignacionNumero,usuarioNumero,anio];
  let estudiante="";
  if(estudianteNumero){params.push(estudianteNumero);estudiante=` AND EXISTS (
    SELECT 1 FROM estudiantes e WHERE e.id=$4 AND e.seccion_id=a.seccion_id
      AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
  )`;}
  const q=await pool.query(`SELECT a.*,m.nombre AS materia_nombre,s.nombre AS seccion_nombre
    FROM asignaciones a JOIN materias m ON m.id=a.materia_id JOIN secciones s ON s.id=a.seccion_id
    WHERE a.id=$1 AND a.profesor_id=$2 AND COALESCE(a.anio,$3)=$3 AND COALESCE(a.activa,true)=true ${estudiante}`,
    params);
  return q.rows[0]||null;
}
async function alertaAccesible(u,id,bloquearEdicion=false){
  const alertaId=enteroPositivo(id);
  if(!alertaId) return {error:"Identificador de alerta inválido.",status:400};
  const q=await pool.query("SELECT * FROM alertas_tempranas WHERE id=$1",[alertaId]);
  if(!q.rows.length) return {error:"Alerta no encontrada.",status:404};
  const alerta=q.rows[0];
  const supervisor=await puedeSupervisar(u);
  if(!supervisor && Number(alerta.profesor_id)!==Number(u.id)) return {error:"Esta alerta no le pertenece.",status:403};
  if(bloquearEdicion && supervisor && Number(alerta.profesor_id)!==Number(u.id))
    return {error:"La supervisión institucional es de solo lectura.",status:403};
  return {alerta,supervisor};
}
function nombreCompleto(alias="e"){
  return `TRIM(CONCAT_WS(' ',${alias}.nombre,${alias}.primer_apellido,${alias}.segundo_apellido))`;
}
function nombreApellidos(alias="e"){
  return `TRIM(CONCAT_WS(' ',${alias}.primer_apellido,${alias}.segundo_apellido,${alias}.nombre))`;
}
async function notificarSupervision(client,mensaje,alertaId,omitido){
  const alertaNumero=enteroPositivo(alertaId),omitidoNumero=enteroPositivo(omitido)||0;
  if(!alertaNumero) throw new Error("No se pudo asociar la notificación con la alerta.");
  await client.query(`INSERT INTO notificaciones(usuario_id,tipo,mensaje,referencia_id,destino)
    SELECT u.id,'alerta_temprana'::text,$1::text,$2::integer,$3::text
    FROM usuarios u
    WHERE u.activo=true AND (
      u.rol IN ('admin','auxiliar','administrativo')
      OR EXISTS (SELECT 1 FROM funciones_institucionales fi WHERE fi.usuario_id=u.id AND fi.tipo='coordinador')
    ) AND u.id<>$4::integer`,[String(mensaje||""),alertaNumero,`alerta-temprana:${alertaNumero}`,omitidoNumero]);
}

router.get("/inicio",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const u=req.session.usuario, anio=await obtenerAnioActivo(), supervisor=await puedeSupervisar(u);
  const asignaciones=esDocente(u)?await pool.query(`
    SELECT DISTINCT ON (a.seccion_id,a.materia_id,COALESCE(a.subgrupo,'')) a.id,a.seccion_id,a.materia_id,
      a.subgrupo,s.nombre AS seccion_nombre,m.nombre AS materia_nombre
    FROM asignaciones a JOIN secciones s ON s.id=a.seccion_id JOIN materias m ON m.id=a.materia_id
    WHERE a.profesor_id=$1 AND COALESCE(a.anio,$2)=$2 AND COALESCE(a.activa,true)=true
    ORDER BY a.seccion_id,a.materia_id,COALESCE(a.subgrupo,''),a.id DESC`,[u.id,anio]):{rows:[]};
  res.json({anio,catalogo:CATALOGO,puede_crear:esDocente(u),puede_supervisar:supervisor,asignaciones:asignaciones.rows});
}));

router.get("/estudiantes",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const a=await asignacionPropia(req.session.usuario.id,req.query.asignacion_id);
  if(!a) return res.status(403).json({error:"La asignación no pertenece a sus clases del año vigente."});
  const q=await pool.query(`SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.fecha_nacimiento,
      ${nombreApellidos("e")} AS nombre_ordenado,${nombreCompleto("e")} AS nombre_completo,
      s.nombre AS seccion_nombre,EXTRACT(YEAR FROM AGE(CURRENT_DATE,e.fecha_nacimiento))::int AS edad,
      COALESCE(NULLIF(enc.celular,''),NULLIF(enc.telefono,''),NULLIF(enc.telefono_trabajo,''),'') AS telefono,
      ${nombreCompleto("enc")} AS encargado_nombre,
      COALESCE(enc.telefono,'') AS encargado_telefono,
      COALESCE(enc.celular,'') AS encargado_celular,
      COALESCE(enc.telefono_trabajo,'') AS encargado_telefono_trabajo
    FROM estudiantes e JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN LATERAL (SELECT * FROM encargados x WHERE x.estudiante_id=e.id ORDER BY x.es_principal DESC,x.id LIMIT 1) enc ON true
    WHERE e.seccion_id=$1 AND e.activo=true AND COALESCE(e.archivado,false)=false
      AND (COALESCE($2::text,'')='' OR UPPER(COALESCE(e.subgrupo,''))=UPPER($2))
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre`,[a.seccion_id,a.subgrupo||""]);
  res.json(q.rows);
}));

router.get("/alertas",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const u=req.session.usuario, supervisor=await puedeSupervisar(u), anio=await obtenerAnioActivo();
  const params=[anio]; let filtro="";
  if(!supervisor){params.push(u.id);filtro=` AND at.profesor_id=$2`;}
  if(req.query.estado && ESTADOS.includes(req.query.estado)){params.push(req.query.estado);filtro+=` AND at.estado=$${params.length}`;}
  const q=await pool.query(`SELECT at.*,${nombreApellidos("e")} AS estudiante_nombre,e.cedula,
      s.nombre AS seccion_nombre,m.nombre AS materia_nombre,${nombreCompleto("u")} AS profesor_nombre,
      (SELECT COUNT(*)::int FROM alerta_temprana_seguimientos sg WHERE sg.alerta_id=at.id) AS seguimientos,
      (SELECT MAX(created_at) FROM alerta_temprana_seguimientos sg WHERE sg.alerta_id=at.id) AS ultimo_seguimiento
    FROM alertas_tempranas at JOIN estudiantes e ON e.id=at.estudiante_id
    LEFT JOIN secciones s ON s.id=at.seccion_id LEFT JOIN materias m ON m.id=at.materia_id JOIN usuarios u ON u.id=at.profesor_id
    WHERE at.anio=$1 ${filtro}
    ORDER BY CASE at.estado WHEN 'activada' THEN 0 WHEN 'en_proceso' THEN 1 WHEN 'en_espera' THEN 2 ELSE 3 END,
      at.updated_at DESC,e.primer_apellido,e.segundo_apellido,e.nombre`,params);
  res.json({solo_lectura:supervisor&&!esDocente(u),alertas:q.rows});
}));

router.post("/alertas",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const u=req.session.usuario;
  if(!esDocente(u)) return res.status(403).json({error:"Solo el personal docente puede abrir una alerta."});
  const estudianteId=enteroPositivo(req.body?.estudiante_id),asignacionId=enteroPositivo(req.body?.asignacion_id);
  if(!estudianteId||!asignacionId) return res.status(400).json({error:"Seleccione la sección, materia y estudiante."});
  const a=await asignacionPropia(u.id,asignacionId,estudianteId);
  if(!a) return res.status(403).json({error:"El estudiante no pertenece a esa asignación."});
  const codigos=[...new Set((Array.isArray(req.body?.categorias)?req.body.categorias:[]).map(Number).filter(c=>CODIGOS.has(c)))];
  const riesgo=req.body?.riesgo_ausentismo===true, obs=String(req.body?.observacion_inicial||"").trim();
  if(!codigos.length&&!riesgo) return res.status(400).json({error:"Seleccione al menos una alerta o riesgo por ausentismo."});
  if(obs.length>10000) return res.status(400).json({error:"La observación inicial es demasiado extensa."});
  const anio=await obtenerAnioActivo(),client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`INSERT INTO alertas_tempranas
      (anio,estudiante_id,profesor_id,asignacion_id,materia_id,seccion_id,riesgo_ausentismo,categorias,observacion_inicial)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [anio,estudianteId,u.id,a.id,a.materia_id,a.seccion_id,riesgo,JSON.stringify(codigos),obs]);
    const id=q.rows[0].id;
    await client.query(`INSERT INTO alerta_temprana_seguimientos(alerta_id,estado,observaciones,registrado_por)
      VALUES($1,'activada',$2,$3)`,[id,obs||"Se abre la Alerta Temprana.",u.id]);
    const est=await client.query(`SELECT ${nombreCompleto("e")} AS nombre FROM estudiantes e WHERE id=$1`,[estudianteId]);
    await notificarSupervision(client,`🚨 Nueva Alerta Temprana de ${est.rows[0]?.nombre||"un estudiante"} en ${a.materia_nombre}.`,id,u.id);
    await client.query("COMMIT");res.json({ok:true,id});
  }catch(e){await client.query("ROLLBACK");if(e.code==="23505") return res.status(409).json({error:"Ya existe una alerta abierta para este estudiante en esta materia."});throw e;}
  finally{client.release();}
}));

router.get("/alertas/:id",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const acceso=await alertaAccesible(req.session.usuario,req.params.id);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  const id=enteroPositivo(req.params.id);
  const [cab,seguimientos,acciones,contactos,cfg]=await Promise.all([
    pool.query(`SELECT at.*,${nombreCompleto("e")} AS estudiante_nombre,${nombreApellidos("e")} AS estudiante_nombre_ordenado,
      e.cedula,e.fecha_nacimiento,EXTRACT(YEAR FROM AGE(at.fecha_activacion,e.fecha_nacimiento))::int AS edad,
      s.nombre AS seccion_nombre,m.nombre AS materia_nombre,${nombreCompleto("u")} AS profesor_nombre,
      ${nombreCompleto("enc")} AS encargado_nombre,
      COALESCE(NULLIF(enc.celular,''),NULLIF(enc.telefono,''),NULLIF(enc.telefono_trabajo,''),'') AS encargado_telefono
      FROM alertas_tempranas at JOIN estudiantes e ON e.id=at.estudiante_id
      LEFT JOIN secciones s ON s.id=at.seccion_id LEFT JOIN materias m ON m.id=at.materia_id JOIN usuarios u ON u.id=at.profesor_id
      LEFT JOIN LATERAL (SELECT * FROM encargados x WHERE x.estudiante_id=e.id ORDER BY x.es_principal DESC,x.id LIMIT 1) enc ON true
      WHERE at.id=$1`,[id]),
    pool.query(`SELECT sg.*,${nombreCompleto("u")} AS registrado_nombre FROM alerta_temprana_seguimientos sg JOIN usuarios u ON u.id=sg.registrado_por WHERE sg.alerta_id=$1 ORDER BY sg.fecha,sg.created_at,sg.id`,[id]),
    pool.query(`SELECT ac.*,${nombreCompleto("u")} AS registrado_nombre FROM alerta_temprana_acciones ac JOIN usuarios u ON u.id=ac.registrado_por WHERE ac.alerta_id=$1 ORDER BY ac.fecha_inicio NULLS LAST,ac.created_at`,[id]),
    pool.query(`SELECT c.*,${nombreCompleto("u")} AS registrado_nombre FROM alerta_temprana_contactos c JOIN usuarios u ON u.id=c.registrado_por WHERE c.alerta_id=$1 ORDER BY c.fecha,c.created_at`,[id]),
    pool.query("SELECT COALESCE(nombre_centro,'Liceo de Calle Fallas') AS nombre_centro FROM config_centro ORDER BY id LIMIT 1")
  ]);
  res.json({alerta:cab.rows[0],seguimientos:seguimientos.rows,acciones:acciones.rows,contactos:contactos.rows,
    catalogo:CATALOGO,centro:cfg.rows[0]?.nombre_centro||"Liceo de Calle Fallas",
    // Una persona coordinadora que también imparte clases conserva edición
    // únicamente sobre las alertas que ella misma abrió; las ajenas son lectura.
    editable:Number(acceso.alerta.profesor_id)===Number(req.session.usuario.id)&&!["cerrada","eliminada"].includes(acceso.alerta.estado)});
}));

router.get("/alertas/:id/excel",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const acceso=await alertaAccesible(req.session.usuario,req.params.id);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  const id=enteroPositivo(req.params.id);
  const [cab,seguimientos,acciones,contactos,cfg]=await Promise.all([
    pool.query(`SELECT at.*,${nombreCompleto("e")} AS estudiante_nombre,e.cedula,
      EXTRACT(YEAR FROM AGE(at.fecha_activacion,e.fecha_nacimiento))::int AS edad,
      s.nombre AS seccion_nombre,m.nombre AS materia_nombre,${nombreCompleto("u")} AS profesor_nombre,
      ${nombreCompleto("enc")} AS encargado_nombre,
      COALESCE(NULLIF(enc.celular,''),NULLIF(enc.telefono,''),NULLIF(enc.telefono_trabajo,''),'') AS encargado_telefono
      FROM alertas_tempranas at JOIN estudiantes e ON e.id=at.estudiante_id
      LEFT JOIN secciones s ON s.id=at.seccion_id LEFT JOIN materias m ON m.id=at.materia_id JOIN usuarios u ON u.id=at.profesor_id
      LEFT JOIN LATERAL (SELECT * FROM encargados x WHERE x.estudiante_id=e.id ORDER BY x.es_principal DESC,x.id LIMIT 1) enc ON true
      WHERE at.id=$1`,[id]),
    pool.query(`SELECT estado,observaciones,fecha,created_at,id FROM alerta_temprana_seguimientos WHERE alerta_id=$1 ORDER BY fecha,created_at,id`,[id]),
    pool.query(`SELECT accion,fecha_inicio,fecha_final,responsable,observaciones,institucion_referida FROM alerta_temprana_acciones WHERE alerta_id=$1 ORDER BY fecha_inicio NULLS LAST,created_at`,[id]),
    pool.query(`SELECT fecha,via_contacto,persona_contactada,comentarios FROM alerta_temprana_contactos WHERE alerta_id=$1 ORDER BY fecha,created_at`,[id]),
    pool.query("SELECT COALESCE(nombre_centro,'Liceo de Calle Fallas') AS nombre_centro FROM config_centro ORDER BY id LIMIT 1")
  ]);
  const a=cab.rows[0];
  if(!a) return res.status(404).json({error:"Alerta no encontrada."});
  const estadoTexto={activada:"Activada",en_proceso:"En proceso",en_espera:"En espera",cerrada:"Cerrada",eliminada:"Eliminada"};
  // Los rótulos superiores ocupan celdas combinadas (por ejemplo B2:D2 y
  // G2:I2). El valor debe escribirse en la celda visible que queda a la
  // derecha, no dentro del rango combinado del rótulo; Excel conserva el
  // contenido interno, pero no lo muestra en pantalla ni al imprimir.
  const hojaBoleta={
    E2:a.estudiante_nombre,J2:a.cedula,L2:a.encargado_telefono||"",E3:a.edad??"",J3:a.seccion_nombre||"",
    L3:fechaDocumento(a.fecha_activacion),E4:a.encargado_nombre||"",K4:a.encargado_telefono||"",
    E5:cfg.rows[0]?.nombre_centro||"Liceo de Calle Fallas",K5:a.profesor_nombre
  };
  if(a.riesgo_ausentismo) hojaBoleta.N11="X";
  const marcadores={1:'G16',2:'G17',3:'G18',4:'G19',5:'G20',6:'N16',7:'N17',8:'N18',9:'N19',10:'G22',11:'G23',12:'G24',13:'G25',14:'G27',15:'G28',16:'G29',17:'G30',18:'N22',19:'N23',20:'N24',21:'N25',22:'N26',23:'N27',24:'N28',25:'N29',26:'N30',27:'G33',28:'G34',29:'G35',30:'N33',31:'N34',32:'G38',33:'G39',34:'G40',35:'G41',36:'N38',37:'N40',38:'N42',39:'G45',40:'G46',41:'G47',42:'G48',43:'N45',44:'N46',45:'N47',46:'G50',47:'G51',48:'G52',49:'G53',50:'G54',51:'G55',52:'G56',53:'N50',54:'N53',55:'G58',56:'G60',57:'G61',58:'G62',59:'N58',60:'N59',61:'N60',62:'N61',63:'N62',64:'G64',65:'G65',66:'G66',67:'G67',68:'G68',69:'N64',70:'N66',71:'G71',72:'G72',73:'G73',74:'G74',75:'G75',76:'N71',77:'N72'};
  const categorias=Array.isArray(a.categorias)?a.categorias:[];
  categorias.map(Number).forEach(c=>{if(marcadores[c]) hojaBoleta[marcadores[c]]="X";});
  const hojaSeguimiento={
    B17:seguimientos.rows.map(x=>`${fechaDocumento(x.fecha)} · ${estadoTexto[x.estado]||x.estado}: ${x.observaciones}`).join("\n"),
    E28:fechaDocumento(a.fecha_activacion),E29:fechaDocumento(a.fecha_cierre),E30:a.profesor_nombre
  };
  const estadoFila={activada:10,en_proceso:11,en_espera:12,cerrada:13,eliminada:14}[a.estado];
  if(estadoFila) hojaSeguimiento[`Q${estadoFila}`]="X";
  // En la plantilla oficial B4:C4 y B17:D17 son rótulos combinados. Los
  // datos deben escribirse en D4 y B18 para que sí queden visibles.
  const hojaPlan={D4:a.estudiante_nombre,C5:a.cedula,C6:a.seccion_nombre||"",C7:a.encargado_telefono||"",C8:categorias.join(", ")};
  acciones.rows.slice(0,4).forEach((x,i)=>{const r=13+i;hojaPlan[`B${r}`]=x.accion;hojaPlan[`D${r}`]=fechaDocumento(x.fecha_inicio);hojaPlan[`E${r}`]=fechaDocumento(x.fecha_final);hojaPlan[`F${r}`]=x.responsable||"";hojaPlan[`G${r}`]=x.observaciones||"";});
  hojaPlan.B18=acciones.rows.map(x=>x.institucion_referida).filter(Boolean).join(", ");
  contactos.rows.slice(0,11).forEach((x,i)=>{const r=22+i;hojaPlan[`B${r}`]=fechaDocumento(x.fecha);hojaPlan[`D${r}`]=x.via_contacto;hojaPlan[`E${r}`]=x.persona_contactada||"";hojaPlan[`F${r}`]=x.comentarios||"";});
  const archivo=await llenarPlantillaAlerta({
    "2.BOLETA_III_CICLO_Y_EDUC__DIV_":hojaBoleta,
    "3.BOLETA_DE_SEGUIMIENTO":hojaSeguimiento,
    "4.PLAN_DE_ATENCIÓN":hojaPlan
  });
  const cedula=String(a.cedula||id).replace(/[^0-9A-Za-z_-]/g,"_");
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="Alerta_Temprana_${cedula}.xlsx"`);
  res.setHeader("Cache-Control","no-store");
  res.send(archivo);
}));

router.post("/alertas/:id/seguimientos",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const acceso=await alertaAccesible(req.session.usuario,req.params.id,true);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  if(Number(acceso.alerta.profesor_id)!==Number(req.session.usuario.id)) return res.status(403).json({error:"Solo quien abrió la alerta puede agregar seguimientos."});
  if(["cerrada","eliminada"].includes(acceso.alerta.estado)) return res.status(409).json({error:"La alerta ya está finalizada."});
  const estado=String(req.body?.estado||""),observaciones=String(req.body?.observaciones||"").trim(),fecha=String(req.body?.fecha||"");
  if(!ESTADOS.includes(estado)||observaciones.length<5) return res.status(400).json({error:"Indique el estado y una observación completa."});
  if(observaciones.length>10000) return res.status(400).json({error:"El seguimiento es demasiado extenso."});
  if(!fechaISOValida(fecha,true)) return res.status(400).json({error:"La fecha del seguimiento no es válida."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`INSERT INTO alerta_temprana_seguimientos(alerta_id,estado,observaciones,registrado_por,fecha)
      VALUES($1,$2,$3,$4,COALESCE($5::date,CURRENT_DATE))`,[acceso.alerta.id,estado,observaciones,req.session.usuario.id,fecha||null]);
    await client.query(`UPDATE alertas_tempranas SET estado=$1,updated_at=NOW(),
      fecha_cierre=CASE WHEN $1 IN ('cerrada','eliminada') THEN COALESCE($2::date,CURRENT_DATE) ELSE NULL END WHERE id=$3`,
      [estado,fecha||null,acceso.alerta.id]);
    const info=await client.query(`SELECT ${nombreCompleto("e")} AS estudiante,m.nombre AS materia FROM alertas_tempranas at JOIN estudiantes e ON e.id=at.estudiante_id LEFT JOIN materias m ON m.id=at.materia_id WHERE at.id=$1`,[acceso.alerta.id]);
    await notificarSupervision(client,`📝 Nuevo seguimiento de Alerta Temprana: ${info.rows[0]?.estudiante||"estudiante"} · ${info.rows[0]?.materia||"materia"} · ${estado.replaceAll("_"," ")}.`,acceso.alerta.id,req.session.usuario.id);
    await client.query("COMMIT");res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));

router.post("/alertas/:id/acciones",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const acceso=await alertaAccesible(req.session.usuario,req.params.id,true);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  if(Number(acceso.alerta.profesor_id)!==Number(req.session.usuario.id)||["cerrada","eliminada"].includes(acceso.alerta.estado))
    return res.status(403).json({error:"La alerta es de solo lectura."});
  const accion=String(req.body?.accion||"").trim();
  if(accion.length<3) return res.status(400).json({error:"Describa la acción de atención."});
  if(accion.length>10000) return res.status(400).json({error:"La acción de atención es demasiado extensa."});
  const fechaInicio=req.body?.fecha_inicio||null,fechaFinal=req.body?.fecha_final||null;
  if(!fechaISOValida(fechaInicio,true)||!fechaISOValida(fechaFinal,true)) return res.status(400).json({error:"Revise las fechas del Plan de Atención."});
  if(fechaInicio&&fechaFinal&&fechaFinal<fechaInicio) return res.status(400).json({error:"La fecha final no puede ser anterior a la fecha inicial."});
  const q=await pool.query(`INSERT INTO alerta_temprana_acciones
    (alerta_id,accion,fecha_inicio,fecha_final,responsable,observaciones,institucion_referida,registrado_por)
    VALUES($1,$2,$3::date,$4::date,$5,$6,$7,$8) RETURNING id`,[acceso.alerta.id,accion,fechaInicio,
      fechaFinal,String(req.body.responsable||"").trim(),String(req.body.observaciones||"").trim(),
      String(req.body.institucion_referida||"").trim(),req.session.usuario.id]);
  await pool.query("UPDATE alertas_tempranas SET updated_at=NOW() WHERE id=$1",[acceso.alerta.id]);
  res.json({ok:true,id:q.rows[0].id});
}));

router.post("/alertas/:id/contactos",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const acceso=await alertaAccesible(req.session.usuario,req.params.id,true);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  if(Number(acceso.alerta.profesor_id)!==Number(req.session.usuario.id)||["cerrada","eliminada"].includes(acceso.alerta.estado))
    return res.status(403).json({error:"La alerta es de solo lectura."});
  const via=String(req.body?.via_contacto||"").trim(),persona=String(req.body?.persona_contactada||"").trim(),comentarios=String(req.body?.comentarios||"").trim();
  if(!via||comentarios.length<3) return res.status(400).json({error:"Indique la vía y el detalle del contacto."});
  if(via.length>500||persona.length>500||comentarios.length>10000) return res.status(400).json({error:"El registro de contacto es demasiado extenso."});
  if(!fechaISOValida(req.body?.fecha||null,true)) return res.status(400).json({error:"La fecha del contacto no es válida."});
  const q=await pool.query(`INSERT INTO alerta_temprana_contactos(alerta_id,fecha,via_contacto,persona_contactada,comentarios,registrado_por)
    VALUES($1,COALESCE($2::date,CURRENT_DATE),$3,$4,$5,$6) RETURNING id`,[acceso.alerta.id,req.body.fecha||null,via,persona,comentarios,req.session.usuario.id]);
  await pool.query("UPDATE alertas_tempranas SET updated_at=NOW() WHERE id=$1",[acceso.alerta.id]);
  res.json({ok:true,id:q.rows[0].id});
}));

router.post("/llamadas",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const u=req.session.usuario;
  if(!esDocente(u)) return res.status(403).json({error:"Solo el personal docente registra llamadas."});
  const estudianteId=enteroPositivo(req.body?.estudiante_id),asignacionId=enteroPositivo(req.body?.asignacion_id);
  if(!estudianteId||!asignacionId) return res.status(400).json({error:"Seleccione la sección, materia y estudiante."});
  const a=await asignacionPropia(u.id,asignacionId,estudianteId);
  if(!a) return res.status(403).json({error:"El estudiante no pertenece a esa asignación."});
  const resultado=String(req.body?.resultado||""),medio=String(req.body?.medio||"");
  if(!RESULTADOS.includes(resultado)||!MEDIOS.includes(medio)||!req.body?.fecha||!req.body?.hora_inicio)
    return res.status(400).json({error:"Complete fecha, hora, medio y resultado."});
  if(!fechaISOValida(req.body.fecha)||!horaValida(req.body.hora_inicio)||!horaValida(req.body?.hora_fin||null,true))
    return res.status(400).json({error:"Revise la fecha y las horas del registro."});
  if(req.body?.hora_fin&&segundosHora(req.body.hora_fin)<segundosHora(req.body.hora_inicio))
    return res.status(400).json({error:"La hora final no puede ser anterior a la hora de inicio."});
  if(medio==="otro"&&!String(req.body?.medio_otro||"").trim())
    return res.status(400).json({error:"Especifique el medio de comunicación utilizado."});
  if(resultado==="otro"&&!String(req.body?.resultado_otro||"").trim())
    return res.status(400).json({error:"Especifique el resultado de la comunicación."});
  if(resultado==="efectiva"&&!String(req.body?.descripcion_situacion||"").trim())
    return res.status(400).json({error:"Cuando la comunicación es efectiva, describa objetivamente la situación."});
  if(resultado==="efectiva"&&(!String(req.body?.atendio_nombre||"").trim()||!String(req.body?.parentesco||"").trim()))
    return res.status(400).json({error:"Indique quién atendió y su parentesco con el estudiante."});
  if(resultado==="efectiva"&&req.body?.parentesco==="Otro"&&!String(req.body?.parentesco_otro||"").trim())
    return res.status(400).json({error:"Especifique el parentesco de la persona que atendió."});
  if(!fechaISOValida(req.body?.fecha_seguimiento||null,true))
    return res.status(400).json({error:"La fecha de seguimiento no es válida."});
  const anio=await obtenerAnioActivo();
  let alertaId=req.body?.alerta_id?enteroPositivo(req.body.alerta_id):null;
  if(req.body?.alerta_id&&!alertaId) return res.status(400).json({error:"La alerta asociada no es válida."});
  if(alertaId){
    const ar=await pool.query(`SELECT id FROM alertas_tempranas WHERE id=$1 AND estudiante_id=$2 AND profesor_id=$3 AND estado NOT IN ('cerrada','eliminada')`,[alertaId,estudianteId,u.id]);
    if(!ar.rows.length) return res.status(400).json({error:"La alerta seleccionada no está abierta o no le pertenece."});
  }else{
    const ar=await pool.query(`SELECT id FROM alertas_tempranas WHERE anio=$1 AND estudiante_id=$2 AND profesor_id=$3
      AND materia_id=$4 AND estado NOT IN ('cerrada','eliminada') ORDER BY updated_at DESC LIMIT 1`,[anio,estudianteId,u.id,a.materia_id]);
    alertaId=ar.rows[0]?.id||null;
  }
  const motivos=[...new Set((Array.isArray(req.body?.motivos)?req.body.motivos:[]).map(x=>String(x).trim()).filter(Boolean))];
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`INSERT INTO registro_llamadas
      (anio,estudiante_id,profesor_id,asignacion_id,materia_id,alerta_id,fecha,hora_inicio,hora_fin,medio,medio_otro,
       numero_marcado,resultado,resultado_otro,atendio_nombre,parentesco,parentesco_otro,motivos,motivo_otro,
       descripcion_situacion,respuesta_encargado,compromisos_encargado,compromisos_docente,fecha_seguimiento,observaciones)
      VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::time,$9::time,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24::date,$25) RETURNING id`,
      [anio,estudianteId,u.id,a.id,a.materia_id,alertaId,req.body.fecha,req.body.hora_inicio,req.body.hora_fin||null,medio,
       String(req.body.medio_otro||"").trim(),String(req.body.numero_marcado||"").trim(),resultado,String(req.body.resultado_otro||"").trim(),
       resultado==="efectiva"?String(req.body.atendio_nombre||"").trim():"",resultado==="efectiva"?String(req.body.parentesco||"").trim():"",
       resultado==="efectiva"?String(req.body.parentesco_otro||"").trim():"",JSON.stringify(resultado==="efectiva"?motivos:[]),
       resultado==="efectiva"?String(req.body.motivo_otro||"").trim():"",resultado==="efectiva"?String(req.body.descripcion_situacion||"").trim():"",
       resultado==="efectiva"?String(req.body.respuesta_encargado||"").trim():"",resultado==="efectiva"?String(req.body.compromisos_encargado||"").trim():"",
       resultado==="efectiva"?String(req.body.compromisos_docente||"").trim():"",resultado==="efectiva"?(req.body.fecha_seguimiento||null):null,
       String(req.body.observaciones||"").trim()]);
    if(alertaId){
      const etiqueta={efectiva:"Comunicación efectiva",no_contesta:"No contestó",equivocado:"Número equivocado",fuera_servicio:"Fuera de servicio",buzon:"Buzón de voz",devolver_llamada:"Solicitó devolver la llamada",otro:req.body.resultado_otro||"Otro resultado"}[resultado];
      await client.query(`INSERT INTO alerta_temprana_contactos(alerta_id,llamada_id,fecha,via_contacto,persona_contactada,comentarios,registrado_por)
        VALUES($1,$2,$3::date,$4,$5,$6,$7)`,[alertaId,q.rows[0].id,req.body.fecha,medio,resultado==="efectiva"?String(req.body.atendio_nombre||"").trim():"Sin contacto",`${etiqueta}. ${String(req.body.observaciones||"").trim()}`.trim(),u.id]);
      await client.query("UPDATE alertas_tempranas SET updated_at=NOW() WHERE id=$1",[alertaId]);
    }
    await client.query("COMMIT");res.json({ok:true,id:q.rows[0].id,enlazada_alerta:Boolean(alertaId),alerta_id:alertaId});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));

router.get("/llamadas",requireAuth,requireParticipante,asyncRoute(async(req,res)=>{
  const u=req.session.usuario,supervisor=await puedeSupervisar(u),anio=await obtenerAnioActivo();
  const params=[anio];let filtro="";
  if(!supervisor){params.push(u.id);filtro+=` AND rl.profesor_id=$${params.length}`;}
  if(req.query.estudiante_id){
    const estudianteId=enteroPositivo(req.query.estudiante_id);
    if(!estudianteId) return res.status(400).json({error:"El estudiante indicado no es válido."});
    params.push(estudianteId);filtro+=` AND rl.estudiante_id=$${params.length}`;
  }
  const q=await pool.query(`SELECT rl.*,${nombreApellidos("e")} AS estudiante_nombre,e.cedula,e.seccion_id,s.nombre AS seccion_nombre,
      m.nombre AS materia_nombre,${nombreCompleto("u")} AS profesor_nombre
    FROM registro_llamadas rl JOIN estudiantes e ON e.id=rl.estudiante_id LEFT JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN materias m ON m.id=rl.materia_id JOIN usuarios u ON u.id=rl.profesor_id
    WHERE rl.anio=$1 ${filtro} ORDER BY rl.fecha DESC,rl.hora_inicio DESC,rl.id DESC`,params);
  res.json({puede_consolidar:supervisor,llamadas:q.rows});
}));

module.exports=router;
