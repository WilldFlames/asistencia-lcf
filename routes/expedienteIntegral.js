const router = require("express").Router();
const { pool } = require("../db");
const { tieneRol } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");
const { CARACTERIZACION_CATALOGO } = require("../utils/catalogoCaracterizacion");

function esAdmin(u){ return tieneRol(u,["admin"]); }
function esOrientador(u){ return tieneRol(u,["orientador"]); }
function nombreUsuario(alias="u"){
  return `TRIM(CONCAT_WS(' ',${alias}.nombre,${alias}.primer_apellido,${alias}.segundo_apellido))`;
}
function condicionOrientador(aliasEstudiante, pUsuario, pAnio){
  return `(${aliasEstudiante}.seccion_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM seccion_orientador_anio soa
      WHERE soa.seccion_id=${aliasEstudiante}.seccion_id AND soa.anio=$${pAnio} AND soa.orientador_id=$${pUsuario})
    OR (NOT EXISTS (SELECT 1 FROM seccion_orientador_anio soa_any
          WHERE soa_any.seccion_id=${aliasEstudiante}.seccion_id AND soa_any.anio=$${pAnio})
      AND EXISTS (SELECT 1 FROM seccion_orientador so
          WHERE so.seccion_id=${aliasEstudiante}.seccion_id AND so.orientador_id=$${pUsuario}))
  ))`;
}
async function estudiantePermitido(id,u,anio,db=pool){
  const params=[id];
  let filtro="";
  if(!esAdmin(u)){
    params.push(u.id,anio);
    filtro=`AND ${condicionOrientador("e",2,3)}`;
  }
  const r=await db.query(`SELECT e.*,s.nombre AS seccion_nombre,s.nivel
    FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.id=$1 ${filtro}` ,params);
  return r.rows[0]||null;
}
async function orientadorResponsable(id,u,anio,db=pool){
  if(!esOrientador(u)) return false;
  const r=await db.query(`SELECT 1 FROM estudiantes e WHERE e.id=$1 AND ${condicionOrientador("e",2,3)} LIMIT 1`,[id,u.id,anio]);
  return r.rows.length>0;
}
function texto(v,max){ return String(v??"").trim().slice(0,max); }

router.use((req,res,next)=>{
  const u=req.session.usuario;
  if(!esAdmin(u)&&!esOrientador(u)) return res.status(403).json({error:"Este apartado es exclusivo de Administración y Orientación."});
  next();
});

router.get("/estudiantes",async(req,res)=>{
  try{
    const u=req.session.usuario, anio=await obtenerAnioActivo();
    const q=texto(req.query.q,100);
    const params=[]; const where=[];
    if(q){ params.push(`%${q}%`); where.push(`(e.cedula ILIKE $${params.length} OR CONCAT_WS(' ',e.nombre,e.primer_apellido,e.segundo_apellido) ILIKE $${params.length} OR CONCAT_WS(' ',e.primer_apellido,e.segundo_apellido,e.nombre) ILIKE $${params.length})`); }
    if(!esAdmin(u)){
      params.push(u.id,anio);
      where.push(condicionOrientador("e",params.length-1,params.length));
    }
    const r=await pool.query(`SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.activo,
      s.nombre AS seccion_nombre,s.nivel
      FROM estudiantes e LEFT JOIN secciones s ON s.id=e.seccion_id
      ${where.length?`WHERE ${where.join(" AND ")}`:""}
      ORDER BY e.activo DESC,s.nivel NULLS LAST,s.nombre NULLS LAST,e.primer_apellido,e.segundo_apellido,e.nombre,e.id
      LIMIT 300`,params);
    res.json({estudiantes:r.rows,puede_incluir_confidenciales:esOrientador(u)});
  }catch(e){ console.error("GET expediente integral estudiantes:",e); res.status(500).json({error:e.message}); }
});

router.post("/generar",async(req,res)=>{
  const u=req.session.usuario;
  const estudianteId=Number(req.body.estudiante_id);
  const entidad=texto(req.body.entidad_solicitante,180);
  const motivo=texto(req.body.motivo,800);
  const incluirConfidenciales=req.body.incluir_confidenciales===true;
  if(!Number.isInteger(estudianteId)||estudianteId<1) return res.status(400).json({error:"Seleccione un estudiante."});
  if(entidad.length<3) return res.status(400).json({error:"Indique la entidad que solicita el expediente."});
  if(motivo.length<5) return res.status(400).json({error:"Indique el motivo de la solicitud."});
  try{
    const anio=await obtenerAnioActivo();
    const est=await estudiantePermitido(estudianteId,u,anio);
    if(!est) return res.status(404).json({error:"Estudiante no encontrado o fuera de los niveles asignados."});
    if(incluirConfidenciales&&!(await orientadorResponsable(estudianteId,u,anio))) return res.status(403).json({error:"Solo la persona orientadora responsable del nivel actual puede incorporar documentación confidencial."});

    const qs=await Promise.all([
      pool.query(`SELECT * FROM encargados WHERE estudiante_id=$1 ORDER BY es_principal DESC,id`,[estudianteId]),
      pool.query(`SELECT m.*,s.nombre AS seccion_actual,${nombreUsuario("u")} AS confirmado_por_nombre FROM matricula m LEFT JOIN secciones s ON s.id=m.seccion_id LEFT JOIN usuarios u ON u.id=m.confirmado_por WHERE m.estudiante_id=$1 ORDER BY m.anio DESC,m.id DESC`,[estudianteId]),
      pool.query(`SELECT * FROM expediente_historico WHERE estudiante_id=$1 ORDER BY anio DESC,id DESC`,[estudianteId]),
      pool.query(`SELECT ea.* FROM expediente_academico ea WHERE ea.estudiante_id=$1 ORDER BY ea.anio DESC,ea.periodo,ea.materia_nombre`,[estudianteId]),
      pool.query(`SELECT ev.id,ev.periodo,ev.tipo,ev.nombre,ev.descripcion,ev.fecha,ev.puntaje_total,ev.valor_porcentual,m.nombre AS materia,${nombreUsuario("u")} AS profesor,
        ne.puntos_obtenidos,(SELECT SUM(ni.puntaje) FROM notas_indicador ni WHERE ni.evaluacion_id=ev.id AND ni.estudiante_id=$1) AS puntos_indicadores,
        (SELECT SUM(i.puntaje_maximo) FROM indicadores i WHERE i.evaluacion_id=ev.id) AS maximo_indicadores
        FROM evaluaciones ev JOIN materias m ON m.id=ev.materia_id LEFT JOIN usuarios u ON u.id=ev.profesor_id
        LEFT JOIN notas_examen ne ON ne.evaluacion_id=ev.id AND ne.estudiante_id=$1
        WHERE (ne.estudiante_id=$1 OR EXISTS(SELECT 1 FROM notas_indicador ni2 WHERE ni2.evaluacion_id=ev.id AND ni2.estudiante_id=$1))
        ORDER BY ev.fecha DESC,ev.id DESC`,[estudianteId]),
      pool.query(`SELECT EXTRACT(YEAR FROM sa.fecha)::int AS anio,m.nombre AS materia,
        COUNT(*) AS sesiones,SUM(sa.lecciones)::int AS lecciones,
        SUM(CASE WHEN a.estado='A' THEN COALESCE(a.lecciones_ausentes,sa.lecciones) ELSE 0 END)::int AS ausencias,
        SUM(CASE WHEN a.estado='T' THEN COALESCE(a.lecciones_tardias,1) ELSE 0 END)::int AS tardias,
        SUM(CASE WHEN a.estado='A' AND a.justificada THEN COALESCE(a.lecciones_ausentes,sa.lecciones) ELSE 0 END)::int AS justificadas
        FROM asistencia a JOIN sesiones_asistencia sa ON sa.id=a.sesion_id JOIN asignaciones asi ON asi.id=sa.asignacion_id JOIN materias m ON m.id=asi.materia_id
        WHERE a.estudiante_id=$1 GROUP BY EXTRACT(YEAR FROM sa.fecha),m.nombre ORDER BY anio DESC,m.nombre`,[estudianteId]),
      pool.query(`SELECT b.id,b.fecha,i.tipo,i.puntos,i.descripcion,b.observacion,m.nombre AS materia,${nombreUsuario("u")} AS registrado_por_nombre
        FROM boletas_conducta b JOIN infracciones i ON i.id=b.infraccion_id LEFT JOIN asignaciones asi ON asi.id=b.asignacion_id LEFT JOIN materias m ON m.id=asi.materia_id LEFT JOIN usuarios u ON u.id=b.registrado_por
        WHERE b.estudiante_id=$1 ORDER BY b.fecha DESC,b.id DESC`,[estudianteId]),
      pool.query(`SELECT * FROM expediente_conducta_detalle WHERE estudiante_id=$1 ORDER BY anio DESC,fecha DESC,id DESC`,[estudianteId]),
      pool.query(`SELECT dp.*,${nombreUsuario("ui")} AS iniciado_por_nombre,${nombreUsuario("uf")} AS finalizado_por_nombre FROM debidos_procesos dp LEFT JOIN usuarios ui ON ui.id=dp.iniciado_por LEFT JOIN usuarios uf ON uf.id=dp.finalizado_por WHERE dp.estudiante_id=$1 ORDER BY dp.anio DESC,dp.numero DESC`,[estudianteId]),
      pool.query(`SELECT p.*,pp.rol,${nombreUsuario("ui")} AS iniciado_por_nombre,${nombreUsuario("uf")} AS finalizado_por_nombre FROM protocolo_personas pp JOIN protocolos p ON p.id=pp.protocolo_id LEFT JOIN usuarios ui ON ui.id=p.iniciado_por LEFT JOIN usuarios uf ON uf.id=p.finalizado_por WHERE pp.estudiante_id=$1 ORDER BY p.anio DESC,p.numero DESC`,[estudianteId]),
      pool.query(`SELECT at.*,m.nombre AS materia,${nombreUsuario("u")} AS profesor_nombre FROM alertas_tempranas at LEFT JOIN materias m ON m.id=at.materia_id LEFT JOIN usuarios u ON u.id=at.profesor_id WHERE at.estudiante_id=$1 ORDER BY at.anio DESC,at.fecha_activacion DESC,at.id DESC`,[estudianteId]),
      pool.query(`SELECT rl.*,m.nombre AS materia,${nombreUsuario("u")} AS profesor_nombre FROM registro_llamadas rl LEFT JOIN materias m ON m.id=rl.materia_id LEFT JOIN usuarios u ON u.id=rl.profesor_id WHERE rl.estudiante_id=$1 ORDER BY rl.fecha DESC,rl.hora_inicio DESC,rl.id DESC`,[estudianteId]),
      pool.query(`SELECT ca.*,${nombreUsuario("u")} AS emitida_por_nombre FROM cartas_ausentismo ca LEFT JOIN usuarios u ON u.id=ca.emitida_por WHERE ca.estudiante_id=$1 ORDER BY ca.fecha DESC,ca.id DESC`,[estudianteId]),
      pool.query(`SELECT ae.* FROM adecuaciones_estudiante ae WHERE ae.estudiante_id=$1`,[estudianteId]),
      pool.query(`SELECT me.*,${nombreUsuario("u")} AS creado_por_nombre FROM medidas_estudiantiles me LEFT JOIN usuarios u ON u.id=me.creado_por WHERE me.estudiante_id=$1 ORDER BY me.fecha_inicio DESC,me.id DESC`,[estudianteId]),
      pool.query(`SELECT i.*,${nombreUsuario("ur")} AS remitente_nombre,${nombreUsuario("ud")} AS destinatario_nombre FROM informes i LEFT JOIN usuarios ur ON ur.id=i.remitente_id LEFT JOIN usuarios ud ON ud.id=i.destinatario_id WHERE i.estudiante_id=$1 ORDER BY i.created_at DESC,i.id DESC`,[estudianteId]),
      pool.query(`SELECT od.*,${nombreUsuario("u")} AS registrado_por_nombre FROM observaciones_diarias od LEFT JOIN usuarios u ON u.id=od.usuario_id WHERE od.estudiante_id=$1 ORDER BY od.fecha DESC,od.id DESC`,[estudianteId]),
      pool.query(`SELECT ect.*,s.nombre AS seccion_nombre,${nombreUsuario("ug")} AS guia_nombre,${nombreUsuario("uc")} AS creado_por_nombre FROM expedientes_conducta_tes ect LEFT JOIN secciones s ON s.id=ect.seccion_id LEFT JOIN usuarios ug ON ug.id=ect.guia_id LEFT JOIN usuarios uc ON uc.id=ect.creado_por WHERE ect.estudiante_id=$1 ORDER BY ect.anio DESC,ect.numero DESC`,[estudianteId]),
      pool.query(`SELECT pr.*,${nombreUsuario("u")} AS registrado_por_nombre FROM porteria_registros pr LEFT JOIN usuarios u ON u.id=pr.registrado_por WHERE pr.estudiante_id=$1 ORDER BY pr.fecha DESC,pr.hora DESC,pr.id DESC`,[estudianteId]),
      pool.query(`SELECT c.*,${nombreUsuario("u")} AS profesor_nombre FROM citas c LEFT JOIN usuarios u ON u.id=c.profesor_id WHERE c.estudiante_id=$1 ORDER BY c.fecha DESC,c.hora DESC,c.id DESC`,[estudianteId]),
      pool.query(`SELECT ex.*,ee.consecutivo,ee.activo AS participacion_activa,${nombreUsuario("u")} AS creado_por_nombre FROM extramuros_estudiantes ee JOIN extramuros ex ON ex.id=ee.extramuro_id LEFT JOIN usuarios u ON u.id=ex.creado_por WHERE ee.estudiante_id=$1 ORDER BY ex.fecha_actividad DESC,ex.id DESC`,[estudianteId]),
      pool.query(`SELECT sad.*,${nombreUsuario("up")} AS profesor_nombre,${nombreUsuario("ur")} AS resuelta_por_nombre FROM solicitudes_adecuacion_docente sad LEFT JOIN usuarios up ON up.id=sad.profesor_id LEFT JOIN usuarios ur ON ur.id=sad.resuelta_por WHERE sad.estudiante_id=$1 ORDER BY sad.created_at DESC,sad.id DESC`,[estudianteId]),
      pool.query(`SELECT dpp.*,dp.numero,dp.anio,${nombreUsuario("u")} AS completado_por_nombre FROM dp_pasos dpp JOIN debidos_procesos dp ON dp.id=dpp.proceso_id LEFT JOIN usuarios u ON u.id=dpp.completado_por WHERE dp.estudiante_id=$1 ORDER BY dp.anio DESC,dp.numero DESC,dpp.orden,dpp.id`,[estudianteId]),
      pool.query(`SELECT pf.*,p.numero,p.anio,p.pauta,${nombreUsuario("u")} AS completado_por_nombre FROM protocolo_formularios pf JOIN protocolos p ON p.id=pf.protocolo_id LEFT JOIN usuarios u ON u.id=pf.completado_por WHERE EXISTS(SELECT 1 FROM protocolo_personas pp WHERE pp.protocolo_id=p.id AND pp.estudiante_id=$1) ORDER BY p.anio DESC,p.numero DESC,pf.orden,pf.id`,[estudianteId]),
      pool.query(`SELECT ats.*,at.anio,at.materia_id,${nombreUsuario("u")} AS registrado_por_nombre FROM alerta_temprana_seguimientos ats JOIN alertas_tempranas at ON at.id=ats.alerta_id LEFT JOIN usuarios u ON u.id=ats.registrado_por WHERE at.estudiante_id=$1 ORDER BY ats.fecha DESC,ats.id DESC`,[estudianteId]),
      pool.query(`SELECT ata.*,at.anio,${nombreUsuario("u")} AS registrado_por_nombre FROM alerta_temprana_acciones ata JOIN alertas_tempranas at ON at.id=ata.alerta_id LEFT JOIN usuarios u ON u.id=ata.registrado_por WHERE at.estudiante_id=$1 ORDER BY ata.created_at DESC,ata.id DESC`,[estudianteId]),
      pool.query(`SELECT ecp.*,ect.numero,ect.anio,${nombreUsuario("u")} AS completado_por_nombre FROM expedientes_conducta_pasos ecp JOIN expedientes_conducta_tes ect ON ect.id=ecp.expediente_id LEFT JOIN usuarios u ON u.id=ecp.completado_por WHERE ect.estudiante_id=$1 ORDER BY ect.anio DESC,ect.numero DESC,ecp.paso`,[estudianteId]),
      pool.query(`SELECT cp.* FROM caracterizaciones_poblacion cp WHERE cp.estudiante_id=$1 AND cp.activo=true ORDER BY cp.anio DESC,cp.codigo`,[estudianteId]),
      incluirConfidenciales ? pool.query(`SELECT m.id,m.numero,m.anio,m.fecha_reunion,m.tema,m.dependencia,m.lugar,m.temas_tratados,m.acuerdos,m.estado,m.created_at
        FROM minuta_estudiantes me JOIN minutas m ON m.id=me.minuta_id
        WHERE me.estudiante_id=$1 AND m.es_confidencial=true ORDER BY m.anio DESC,m.numero DESC`,[estudianteId]) : Promise.resolve({rows:[]})
    ]);
    const claves=["encargados","matriculas","historial_matricula","academico_historico","evaluaciones","asistencia","conducta_actual","conducta_historica","debidos_procesos","pautas","alertas_tempranas","llamadas","cartas_ausentismo","adecuaciones","medidas","informes","observaciones","expedientes_conducta","porteria","citas","extramuros","solicitudes_adecuacion","pasos_debidos","formularios_pautas","seguimientos_alerta","acciones_alerta","pasos_tes","caracterizaciones","minutas_confidenciales"];
    const datos={}; claves.forEach((k,i)=>datos[k]=qs[i].rows);
    const catalogo=new Map((CARACTERIZACION_CATALOGO||[]).map(x=>[Number(x.codigo),x.descripcion||String(x.codigo)]));
    datos.caracterizaciones=datos.caracterizaciones.map(x=>({...x,descripcion:catalogo.get(Number(x.codigo))||`Caracterización ${x.codigo}`}));
    const audit=await pool.query(`INSERT INTO expediente_integral_generaciones
      (estudiante_id,generado_por,entidad_solicitante,motivo,incluye_confidenciales,curso_lectivo)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,generado_at`,[estudianteId,u.id,entidad,motivo,incluirConfidenciales,anio]);
    res.json({estudiante:est,datos,auditoria:{...audit.rows[0],entidad_solicitante:entidad,motivo,incluye_confidenciales:incluirConfidenciales,curso_lectivo:anio,generado_por:[u.nombre,u.primer_apellido,u.segundo_apellido].filter(Boolean).join(" ")}});
  }catch(e){ console.error("POST expediente integral generar:",e); res.status(500).json({error:e.message}); }
});

module.exports=router;
