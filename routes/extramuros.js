const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");

const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const ROLES = new Set(["admin","auxiliar","administrativo","secretaria","profesor","profesor_guia","orientador"]);
const SUPERVISION = new Set(["admin","auxiliar","administrativo","secretaria"]);

function enteroPositivo(valor){
  const numero=Number(valor);
  return Number.isSafeInteger(numero)&&numero>0?numero:null;
}

function idsUnicos(valores){
  if(!Array.isArray(valores)) return [];
  return [...new Set(valores.map(enteroPositivo).filter(Boolean))];
}

function texto(valor,maximo){
  return String(valor??"").trim().slice(0,maximo);
}

function fechaValida(valor){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor||""));
  if(!m) return false;
  const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])));
  return d.getUTCFullYear()===Number(m[1])&&d.getUTCMonth()===Number(m[2])-1&&d.getUTCDate()===Number(m[3]);
}

function horaValida(valor){
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(valor||"").slice(0,5));
}

function minutos(valor){
  const [h,m]=String(valor||"").split(":").map(Number);
  return h*60+m;
}

function permitido(u){
  if(!u) return false;
  if(ROLES.has(u.rol)) return true;
  return (u.funciones_extra||[]).some(r=>["profesor_guia","orientador"].includes(r));
}

function supervisor(u){ return !!u&&SUPERVISION.has(u.rol); }

function requireExtramuros(req,res,next){
  if(permitido(req.session?.usuario)) return next();
  return res.status(403).json({error:"Sin permiso para gestionar extramuros."});
}

function datosEntrada(body={}){
  return {
    nombre_actividad:texto(body.nombre_actividad,240),
    objeto_actividad:texto(body.objeto_actividad,500),
    mediacion_pedagogica:texto(body.mediacion_pedagogica,1000),
    lugar_actividad:texto(body.lugar_actividad,300),
    fecha_actividad:String(body.fecha_actividad||"").slice(0,10),
    hora_salida:String(body.hora_salida||"").slice(0,5),
    hora_regreso:String(body.hora_regreso||"").slice(0,5),
    observaciones:texto(body.observaciones,1000),
    descripcion_exoneracion:texto(body.descripcion_exoneracion,500),
    responsables:idsUnicos(body.responsables),
    estudiantes:idsUnicos(body.estudiantes),
  };
}

function validarDatos(d){
  if(!d.nombre_actividad||!d.objeto_actividad||!d.mediacion_pedagogica||!d.lugar_actividad||!d.descripcion_exoneracion)
    return "Complete todos los datos de la actividad.";
  if(!fechaValida(d.fecha_actividad)||!horaValida(d.hora_salida)||!horaValida(d.hora_regreso))
    return "La fecha o las horas de la actividad no son válidas.";
  if(minutos(d.hora_regreso)<=minutos(d.hora_salida)) return "La hora de regreso debe ser posterior a la hora de salida.";
  if(!d.responsables.length) return "Seleccione al menos una persona responsable.";
  if(!d.estudiantes.length) return "Seleccione al menos un estudiante.";
  return null;
}

async function validarCatalogos(client,d){
  const usuarios=await client.query(`SELECT id FROM usuarios
    WHERE id=ANY($1::int[]) AND activo=true AND COALESCE(eliminado,false)=false`,[d.responsables]);
  if(usuarios.rows.length!==d.responsables.length) throw Object.assign(new Error("Alguna persona responsable ya no está activa."),{status:400});
  const estudiantes=await client.query(`SELECT id FROM estudiantes
    WHERE id=ANY($1::int[]) AND activo=true AND COALESCE(archivado,false)=false AND seccion_id IS NOT NULL`,[d.estudiantes]);
  if(estudiantes.rows.length!==d.estudiantes.length) throw Object.assign(new Error("Algún estudiante ya no está activo o no tiene sección."),{status:400});
}

async function actividadAccesible(u,id,edicion=false,client=pool){
  const extramuroId=enteroPositivo(id);
  if(!extramuroId) return {error:"Identificador de extramuros inválido.",status:400};
  const r=await client.query("SELECT * FROM extramuros WHERE id=$1",[extramuroId]);
  if(!r.rows.length) return {error:"Extramuros no encontrado.",status:404};
  const actividad=r.rows[0];
  const esSupervisor=supervisor(u);
  const esCreador=Number(actividad.creado_por)===Number(u.id);
  let esResponsable=false;
  if(!esSupervisor&&!esCreador){
    const rr=await client.query("SELECT 1 FROM extramuros_responsables WHERE extramuro_id=$1 AND usuario_id=$2",[extramuroId,u.id]);
    esResponsable=rr.rows.length>0;
  }
  if(!esSupervisor&&!esCreador&&!esResponsable) return {error:"Este extramuros no le pertenece.",status:403};
  if(edicion&&!esSupervisor&&!esCreador) return {error:"Solo la persona creadora o la supervisión puede modificarlo.",status:403};
  return {actividad,esSupervisor,esCreador,esResponsable};
}

router.use(requireAuth,requireExtramuros);

router.get("/catalogos",asyncRoute(async(req,res)=>{
  const anio=await obtenerAnioActivo();
  const [secciones,estudiantes,responsables]=await Promise.all([
    pool.query(`SELECT s.id,s.nombre,s.nivel FROM secciones s
      JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true
      ORDER BY s.nivel,s.nombre`,[anio]),
    pool.query(`SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.seccion_id,
        s.nombre AS seccion_nombre,s.nivel
      FROM estudiantes e JOIN secciones s ON s.id=e.seccion_id
      JOIN secciones_anio sa ON sa.seccion_id=s.id AND sa.anio=$1 AND sa.activa=true
      WHERE e.activo=true AND COALESCE(e.archivado,false)=false
      ORDER BY s.nivel,s.nombre,e.primer_apellido,e.segundo_apellido,e.nombre`,[anio]),
    pool.query(`SELECT DISTINCT u.id,u.cedula,u.nombre,u.primer_apellido,u.segundo_apellido,u.rol
      FROM usuarios u
      WHERE u.activo=true AND COALESCE(u.eliminado,false)=false
        AND (u.rol IN ('admin','auxiliar','administrativo','secretaria','profesor','profesor_guia','orientador')
          OR EXISTS (SELECT 1 FROM asignaciones a WHERE a.profesor_id=u.id AND COALESCE(a.anio,$1)=$1))
      ORDER BY u.primer_apellido,u.segundo_apellido,u.nombre`,[anio])
  ]);
  res.json({anio,secciones:secciones.rows,estudiantes:estudiantes.rows,responsables:responsables.rows});
}));

router.get("/listado",asyncRoute(async(req,res)=>{
  const anio=enteroPositivo(req.query.anio)||await obtenerAnioActivo();
  const u=req.session.usuario,params=[anio];
  let acceso="";
  if(!supervisor(u)){
    params.push(u.id);
    acceso=` AND (x.creado_por=$2 OR EXISTS (
      SELECT 1 FROM extramuros_responsables xr WHERE xr.extramuro_id=x.id AND xr.usuario_id=$2
    ))`;
  }
  const q=await pool.query(`SELECT xe.consecutivo,xe.anio,x.id AS extramuro_id,x.nombre_actividad,
      x.fecha_actividad::text,x.lugar_actividad,x.estado,e.id AS estudiante_id,e.cedula,
      e.nombre,e.primer_apellido,e.segundo_apellido,s.nombre AS seccion_nombre,
      uc.nombre AS creador_nombre,uc.primer_apellido AS creador_ap1,uc.segundo_apellido AS creador_ap2
    FROM extramuros_estudiantes xe JOIN extramuros x ON x.id=xe.extramuro_id
    JOIN estudiantes e ON e.id=xe.estudiante_id LEFT JOIN secciones s ON s.id=e.seccion_id
    JOIN usuarios uc ON uc.id=x.creado_por
    WHERE xe.anio=$1 AND xe.activo=true AND x.estado='activo' ${acceso}
    ORDER BY xe.consecutivo`,params);
  res.json(q.rows);
}));

router.get("/",asyncRoute(async(req,res)=>{
  const anio=enteroPositivo(req.query.anio)||await obtenerAnioActivo();
  const u=req.session.usuario,params=[anio];
  let acceso="";
  if(!supervisor(u)){
    params.push(u.id);
    acceso=` AND (x.creado_por=$2 OR EXISTS (
      SELECT 1 FROM extramuros_responsables xr WHERE xr.extramuro_id=x.id AND xr.usuario_id=$2
    ))`;
  }
  const q=await pool.query(`SELECT x.id,x.anio,x.nombre_actividad,x.objeto_actividad,x.lugar_actividad,
      x.fecha_actividad::text,x.hora_salida::text,x.hora_regreso::text,x.estado,x.created_at,
      u.nombre AS creador_nombre,u.primer_apellido AS creador_ap1,u.segundo_apellido AS creador_ap2,
      COUNT(DISTINCT xe.id) FILTER (WHERE xe.activo=true)::int AS estudiantes,
      MIN(xe.consecutivo) FILTER (WHERE xe.activo=true)::int AS consecutivo_desde,
      MAX(xe.consecutivo) FILTER (WHERE xe.activo=true)::int AS consecutivo_hasta,
      COUNT(DISTINCT xr.usuario_id)::int AS responsables
    FROM extramuros x JOIN usuarios u ON u.id=x.creado_por
    LEFT JOIN extramuros_estudiantes xe ON xe.extramuro_id=x.id
    LEFT JOIN extramuros_responsables xr ON xr.extramuro_id=x.id
    WHERE x.anio=$1 AND x.estado='activo' ${acceso}
    GROUP BY x.id,u.id ORDER BY x.fecha_actividad DESC,x.id DESC`,params);
  res.json(q.rows);
}));

router.post("/",asyncRoute(async(req,res)=>{
  const d=datosEntrada(req.body),error=validarDatos(d);
  if(error) return res.status(400).json({error});
  const anio=await obtenerAnioActivo(),client=await pool.connect();
  try{
    await client.query("BEGIN");
    await validarCatalogos(client,d);
    const x=await client.query(`INSERT INTO extramuros
      (anio,nombre_actividad,objeto_actividad,mediacion_pedagogica,lugar_actividad,fecha_actividad,
       hora_salida,hora_regreso,observaciones,descripcion_exoneracion,creado_por)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [anio,d.nombre_actividad,d.objeto_actividad,d.mediacion_pedagogica,d.lugar_actividad,
       d.fecha_actividad,d.hora_salida,d.hora_regreso,d.observaciones,d.descripcion_exoneracion,req.session.usuario.id]);
    const id=x.rows[0].id;
    for(let i=0;i<d.responsables.length;i++) await client.query(
      "INSERT INTO extramuros_responsables(extramuro_id,usuario_id,orden) VALUES($1,$2,$3)",[id,d.responsables[i],i]);
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[76102,anio]);
    const ultimo=await client.query("SELECT COALESCE(MAX(consecutivo),0)::int AS n FROM extramuros_estudiantes WHERE anio=$1",[anio]);
    let numero=ultimo.rows[0].n;
    for(let i=0;i<d.estudiantes.length;i++) await client.query(
      `INSERT INTO extramuros_estudiantes(extramuro_id,estudiante_id,anio,consecutivo,orden)
       VALUES($1,$2,$3,$4,$5)`,[id,d.estudiantes[i],anio,++numero,i]);
    await client.query("COMMIT");
    res.json({ok:true,id,consecutivo_desde:numero-d.estudiantes.length+1,consecutivo_hasta:numero});
  }catch(e){
    await client.query("ROLLBACK");
    if(e.status) return res.status(e.status).json({error:e.message});
    throw e;
  }finally{client.release();}
}));

router.get("/:id",asyncRoute(async(req,res)=>{
  const acceso=await actividadAccesible(req.session.usuario,req.params.id);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  const id=acceso.actividad.id;
  const [responsables,estudiantes,config]=await Promise.all([
    pool.query(`SELECT u.id,u.cedula,u.nombre,u.primer_apellido,u.segundo_apellido,u.rol,xr.orden
      FROM extramuros_responsables xr JOIN usuarios u ON u.id=xr.usuario_id
      WHERE xr.extramuro_id=$1 ORDER BY xr.orden,u.primer_apellido,u.segundo_apellido,u.nombre`,[id]),
    pool.query(`SELECT xe.id AS participante_id,xe.consecutivo,xe.orden,e.id,e.cedula,e.nombre,
        e.primer_apellido,e.segundo_apellido,e.fecha_nacimiento,e.enfermedad,e.medicamento,e.telefonos_emergencia,
        s.nombre AS seccion_nombre,s.nivel,
        enc.cedula AS encargado_cedula,enc.nombre AS encargado_nombre,enc.primer_apellido AS encargado_ap1,
        enc.segundo_apellido AS encargado_ap2,enc.parentesco AS encargado_parentesco,
        enc.telefono AS encargado_telefono,enc.celular AS encargado_celular,
        enc.telefono_trabajo AS encargado_telefono_trabajo,enc.email AS encargado_email
      FROM extramuros_estudiantes xe JOIN estudiantes e ON e.id=xe.estudiante_id
      LEFT JOIN secciones s ON s.id=e.seccion_id
      LEFT JOIN LATERAL (SELECT * FROM encargados z WHERE z.estudiante_id=e.id
        ORDER BY z.es_principal DESC,z.id LIMIT 1) enc ON true
      WHERE xe.extramuro_id=$1 AND xe.activo=true ORDER BY xe.orden,xe.consecutivo`,[id]),
    pool.query("SELECT * FROM config_centro LIMIT 1")
  ]);
  res.json({actividad:acceso.actividad,responsables:responsables.rows,estudiantes:estudiantes.rows,
    config:config.rows[0]||{},editable:acceso.esSupervisor||acceso.esCreador});
}));

router.put("/:id",asyncRoute(async(req,res)=>{
  const d=datosEntrada(req.body),error=validarDatos(d);
  if(error) return res.status(400).json({error});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const acceso=await actividadAccesible(req.session.usuario,req.params.id,true,client);
    if(acceso.error){await client.query("ROLLBACK");return res.status(acceso.status).json({error:acceso.error});}
    if(acceso.actividad.estado!=="activo"){await client.query("ROLLBACK");return res.status(400).json({error:"Un extramuros anulado no se puede modificar."});}
    await validarCatalogos(client,d);
    await client.query(`UPDATE extramuros SET nombre_actividad=$1,objeto_actividad=$2,mediacion_pedagogica=$3,
      lugar_actividad=$4,fecha_actividad=$5,hora_salida=$6,hora_regreso=$7,observaciones=$8,
      descripcion_exoneracion=$9,updated_at=NOW() WHERE id=$10`,
      [d.nombre_actividad,d.objeto_actividad,d.mediacion_pedagogica,d.lugar_actividad,d.fecha_actividad,
       d.hora_salida,d.hora_regreso,d.observaciones,d.descripcion_exoneracion,acceso.actividad.id]);
    await client.query("DELETE FROM extramuros_responsables WHERE extramuro_id=$1",[acceso.actividad.id]);
    for(let i=0;i<d.responsables.length;i++) await client.query(
      "INSERT INTO extramuros_responsables(extramuro_id,usuario_id,orden) VALUES($1,$2,$3)",[acceso.actividad.id,d.responsables[i],i]);
    const existentes=await client.query("SELECT estudiante_id FROM extramuros_estudiantes WHERE extramuro_id=$1",[acceso.actividad.id]);
    const conocidos=new Set(existentes.rows.map(x=>Number(x.estudiante_id)));
    await client.query("UPDATE extramuros_estudiantes SET activo=false WHERE extramuro_id=$1",[acceso.actividad.id]);
    for(let i=0;i<d.estudiantes.length;i++) if(conocidos.has(d.estudiantes[i])) await client.query(
      "UPDATE extramuros_estudiantes SET activo=true,orden=$1 WHERE extramuro_id=$2 AND estudiante_id=$3",
      [i,acceso.actividad.id,d.estudiantes[i]]);
    const nuevos=d.estudiantes.filter(id=>!conocidos.has(id));
    if(nuevos.length){
      await client.query("SELECT pg_advisory_xact_lock($1,$2)",[76102,acceso.actividad.anio]);
      const ultimo=await client.query("SELECT COALESCE(MAX(consecutivo),0)::int AS n FROM extramuros_estudiantes WHERE anio=$1",[acceso.actividad.anio]);
      let numero=ultimo.rows[0].n;
      for(const estudianteId of nuevos) await client.query(
        `INSERT INTO extramuros_estudiantes(extramuro_id,estudiante_id,anio,consecutivo,orden)
         VALUES($1,$2,$3,$4,$5)`,[acceso.actividad.id,estudianteId,acceso.actividad.anio,++numero,d.estudiantes.indexOf(estudianteId)]);
    }
    await client.query("COMMIT");res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");if(e.status)return res.status(e.status).json({error:e.message});throw e;}
  finally{client.release();}
}));

router.delete("/:id",asyncRoute(async(req,res)=>{
  const acceso=await actividadAccesible(req.session.usuario,req.params.id,true);
  if(acceso.error) return res.status(acceso.status).json({error:acceso.error});
  const motivo=texto(req.body?.motivo,500);
  if(!motivo) return res.status(400).json({error:"Indique el motivo de la anulación."});
  await pool.query(`UPDATE extramuros SET estado='anulado',motivo_anulacion=$1,anulado_por=$2,
    anulado_at=NOW(),updated_at=NOW() WHERE id=$3 AND estado='activo'`,[motivo,req.session.usuario.id,acceso.actividad.id]);
  res.json({ok:true});
}));

module.exports=router;
