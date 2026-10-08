const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo, obtenerCalendario } = require("../utils/lectivo");

const PROYECTOS = ["reparacion_comunitaria","aseo_comunitario","aprendizaje_servicio"];
const esAdmin = u => u?.rol === "admin";

// Compatibilidad institucional: antes de existir este módulo, las tres
// personas que cumplen la función evaluadora ya estaban registradas como
// Comité Técnico Asesor. Si Dirección crea luego un Comité de Evaluación
// separado, ese grupo explícito tiene prioridad; de lo contrario reutilizamos
// los tres integrantes actuales sin duplicar asignaciones.
async function tipoComiteActivo(db=pool){
  const r=await db.query("SELECT COUNT(*)::int AS n FROM funciones_institucionales WHERE tipo='comite_evaluacion'");
  return r.rows[0].n>0 ? "comite_evaluacion" : "comite_tecnico_asesor";
}

async function esComite(usuarioId, db=pool){
  const tipo=await tipoComiteActivo(db);
  const r=await db.query("SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo=$2",[usuarioId,tipo]);
  return !!r.rows.length;
}

async function seccionesGuia(usuarioId, anio, db=pool){
  const r=await db.query(`SELECT DISTINCT seccion_id FROM seccion_guia_anio WHERE profesor_id=$1 AND anio=$2
    UNION SELECT DISTINCT seccion_id FROM seccion_guia WHERE profesor_id=$1`,[usuarioId,anio]);
  return r.rows.map(x=>Number(x.seccion_id));
}

async function puedeVer(u, expediente, db=pool){
  if(esAdmin(u) || await esComite(u.id,db)) return true;
  if(Number(expediente.guia_id)===Number(u.id)) return true;
  const ids=await seccionesGuia(u.id,expediente.anio,db);
  return ids.includes(Number(expediente.seccion_id));
}

async function cargarExpediente(id, db=pool){
  const r=await db.query(`SELECT ec.*,
      e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.activo AS estudiante_activo,
      s.nombre AS seccion_nombre,s.nivel,
      ug.nombre AS guia_nombre,ug.primer_apellido AS guia_ap1,ug.segundo_apellido AS guia_ap2,
      uc.nombre AS creador_nombre,uc.primer_apellido AS creador_ap1,uc.segundo_apellido AS creador_ap2
    FROM expedientes_conducta_tes ec
    JOIN estudiantes e ON e.id=ec.estudiante_id JOIN secciones s ON s.id=ec.seccion_id
    LEFT JOIN usuarios ug ON ug.id=ec.guia_id LEFT JOIN usuarios uc ON uc.id=ec.creado_por
    WHERE ec.id=$1`,[id]);
  return r.rows[0];
}

router.get("/listado", requireAuth, async (req,res)=>{
  try{
    const u=req.session.usuario;
    const anio=Number(req.query.anio)||await obtenerAnioActivo();
    const cal=await obtenerCalendario(anio);
    const desdeI=cal.periodo_i_inicio||`${anio}-01-01`, hastaI=cal.periodo_i_fin||`${anio}-06-30`;
    const desdeII=cal.periodo_ii_inicio||`${anio}-07-01`, hastaII=cal.periodo_ii_fin||`${anio}-12-31`;
    const comite=await esComite(u.id);
    const ids=(esAdmin(u)||comite)?[]:await seccionesGuia(u.id,anio);
    if(!esAdmin(u)&&!comite&&!ids.length) return res.json({anio,puede_abrir:false,comite:false,miembros_comite:0,estudiantes:[]});
    const params=[anio,desdeI,hastaI,desdeII,hastaII];
    let filtro="";
    if(ids.length){ params.push(ids); filtro=`AND e.seccion_id = ANY($${params.length}::int[])`; }
    const r=await pool.query(`
      WITH notas AS (
        SELECT e.id,
          GREATEST(0,100-COALESCE(SUM(i.puntos) FILTER(WHERE b.fecha BETWEEN $2 AND $3),0)) AS nota_i,
          GREATEST(0,100-COALESCE(SUM(i.puntos) FILTER(WHERE b.fecha BETWEEN $4 AND $5),0)) AS nota_ii
        FROM estudiantes e LEFT JOIN boletas_conducta b ON b.estudiante_id=e.id
        LEFT JOIN infracciones i ON i.id=b.infraccion_id GROUP BY e.id
      )
      SELECT e.id AS estudiante_id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.activo,
        s.id AS seccion_id,s.nombre AS seccion_nombre,s.nivel,n.nota_i,n.nota_ii,
        ROUND((n.nota_i+n.nota_ii)/2.0,1) AS nota_anual,
        CASE WHEN s.nivel<=9 THEN 65 ELSE 70 END AS minimo,
        ec.id AS expediente_id,ec.numero,ec.estado,ec.proyecto,ec.nota_final_conducta
      FROM estudiantes e JOIN secciones s ON s.id=e.seccion_id JOIN notas n ON n.id=e.id
      LEFT JOIN expedientes_conducta_tes ec ON ec.estudiante_id=e.id AND ec.anio=$1
      WHERE (e.activo=true OR ec.id IS NOT NULL) ${filtro}
        AND (ROUND((n.nota_i+n.nota_ii)/2.0,1) < CASE WHEN s.nivel<=9 THEN 65 ELSE 70 END OR ec.id IS NOT NULL)
      ORDER BY s.nivel,s.nombre,e.primer_apellido,e.segundo_apellido,e.nombre`,params);
    const tipoComite=await tipoComiteActivo();
    const mc=await pool.query("SELECT COUNT(*)::int AS n FROM funciones_institucionales WHERE tipo=$1",[tipoComite]);
    res.json({anio,puede_abrir:esAdmin(u)||ids.length>0,comite,miembros_comite:mc.rows[0].n,tipo_comite:tipoComite,estudiantes:r.rows});
  }catch(e){console.error("GET expedientes conducta listado",e);res.status(500).json({error:e.message});}
});

router.post("/abrir", requireAuth, async (req,res)=>{
  const u=req.session.usuario, estudianteId=Number(req.body.estudiante_id), anio=Number(req.body.anio)||await obtenerAnioActivo();
  if(!estudianteId) return res.status(400).json({error:"Seleccione el estudiante."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const er=await client.query(`SELECT e.id,e.seccion_id,s.nivel FROM estudiantes e JOIN secciones s ON s.id=e.seccion_id WHERE e.id=$1 FOR UPDATE`,[estudianteId]);
    if(!er.rows.length) throw new Error("Estudiante no encontrado.");
    const sec=er.rows[0];
    const ids=await seccionesGuia(u.id,anio,client);
    if(!esAdmin(u)&&!ids.includes(Number(sec.seccion_id))) throw Object.assign(new Error("Solo el profesor guía de la sección puede abrir este expediente."),{status:403});
    const existente=await client.query("SELECT id FROM expedientes_conducta_tes WHERE estudiante_id=$1 AND anio=$2",[estudianteId,anio]);
    if(existente.rows.length){await client.query("ROLLBACK");return res.json({ok:true,id:existente.rows[0].id,existente:true});}
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[31877,anio]);
    const nr=await client.query("SELECT COALESCE(MAX(numero),0)+1 AS numero FROM expedientes_conducta_tes WHERE anio=$1",[anio]);
    const guia=await client.query(`SELECT profesor_id FROM seccion_guia_anio WHERE seccion_id=$1 AND anio=$2
      UNION ALL SELECT profesor_id FROM seccion_guia WHERE seccion_id=$1 LIMIT 1`,[sec.seccion_id,anio]);
    const notaAnual=Number.isFinite(Number(req.body.nota_anual))?Math.max(0,Math.min(100,Number(req.body.nota_anual))):null;
    const r=await client.query(`INSERT INTO expedientes_conducta_tes(numero,anio,estudiante_id,seccion_id,guia_id,creado_por,estado,nota_anual)
      VALUES($1,$2,$3,$4,$5,$6,'en_curso',$7) RETURNING id`,[nr.rows[0].numero,anio,estudianteId,sec.seccion_id,guia.rows[0]?.profesor_id||u.id,u.id,notaAnual]);
    await client.query(`INSERT INTO expedientes_conducta_pasos(expediente_id,paso,contenido)
      SELECT $1,n,'{}'::jsonb FROM generate_series(1,7) n`,[r.rows[0].id]);
    await client.query("COMMIT");
    res.json({ok:true,id:r.rows[0].id});
  }catch(e){await client.query("ROLLBACK");console.error("abrir expediente conducta",e);res.status(e.status||400).json({error:e.message});}
  finally{client.release();}
});

router.get("/:id", requireAuth, async (req,res)=>{
  try{
    const ec=await cargarExpediente(req.params.id);
    if(!ec) return res.status(404).json({error:"Expediente no encontrado."});
    if(!await puedeVer(req.session.usuario,ec)) return res.status(403).json({error:"No tiene acceso a este expediente."});
    const pasos=await pool.query(`SELECT p.*,u.nombre AS completado_nombre,u.primer_apellido AS completado_ap1,u.segundo_apellido AS completado_ap2
      FROM expedientes_conducta_pasos p LEFT JOIN usuarios u ON u.id=p.completado_por WHERE p.expediente_id=$1 ORDER BY paso`,[ec.id]);
    const tipoComite=await tipoComiteActivo();
    const aprobaciones=await pool.query(`SELECT a.*,u.nombre,u.primer_apellido,u.segundo_apellido
      FROM expedientes_conducta_aprobaciones a JOIN usuarios u ON u.id=a.usuario_id
      JOIN funciones_institucionales fi ON fi.usuario_id=a.usuario_id AND fi.tipo=$2
      WHERE a.expediente_id=$1 ORDER BY a.aprobado_en`,[ec.id,tipoComite]);
    const miembros=await pool.query(`SELECT u.id,u.nombre,u.primer_apellido,u.segundo_apellido,
      EXISTS(SELECT 1 FROM expedientes_conducta_aprobaciones a WHERE a.expediente_id=$1 AND a.usuario_id=u.id) AS aprobado
      FROM funciones_institucionales fi JOIN usuarios u ON u.id=fi.usuario_id WHERE fi.tipo=$2 ORDER BY u.nombre,u.primer_apellido`,[ec.id,tipoComite]);
    // La accion correctiva puede haberse consignado en el acta, el traslado o la
    // resolucion final.  No se limita la consulta a procesos cerrados: la constancia
    // oficial tambien debe mencionar procedimientos abiertos, aunque aun no tengan
    // una accion firme (estos no se consideran incumplimiento).
    const procedimientos=await pool.query(`SELECT dp.id,dp.numero,dp.anio,dp.estado,
      COALESCE(NULLIF(r.contenido->>'desc_accion',''),NULLIF(t.contenido->>'desc_accion',''),
        NULLIF(a.contenido->>'desc_accion',''),'') AS accion,
      COALESCE(NULLIF(r.contenido->>'fecha_limite',''),NULLIF(r.contenido->>'fecha_inicio_accion',''),
        NULLIF(r.contenido->>'fecha_resol',''),NULLIF(t.contenido->>'fecha_traslado',''),'') AS fecha,
      COALESCE(NULLIF(r.contenido->>'fecha_resol',''),NULLIF(t.contenido->>'fecha_traslado',''),'') AS fecha_resolucion
      FROM debidos_procesos dp
      LEFT JOIN dp_pasos r ON r.proceso_id=dp.id AND r.tipo='resolucion_final'
      LEFT JOIN dp_pasos t ON t.proceso_id=dp.id AND t.tipo='traslado_cargos'
      LEFT JOIN dp_pasos a ON a.proceso_id=dp.id AND a.tipo='acta_sesion'
      WHERE dp.estudiante_id=$1 AND dp.anio=$2
      ORDER BY dp.numero`,[ec.estudiante_id,ec.anio]);
    const acciones=procedimientos.rows.filter(x=>String(x.accion||"").trim());
    const encargados=await pool.query(`SELECT id,nombre,primer_apellido,segundo_apellido,parentesco,
        cedula,telefono,celular,es_principal
      FROM encargados WHERE estudiante_id=$1
      ORDER BY es_principal DESC,primer_apellido,segundo_apellido,nombre,id`,[ec.estudiante_id]);
    res.json({expediente:ec,pasos:pasos.rows,aprobaciones:aprobaciones.rows,miembros:miembros.rows,
      procedimientos_debidos:procedimientos.rows,acciones_correctivas:acciones,encargados:encargados.rows,
      es_admin:esAdmin(req.session.usuario),es_comite:await esComite(req.session.usuario.id)});
  }catch(e){console.error("detalle expediente conducta",e);res.status(500).json({error:e.message});}
});

router.put("/:id/pasos/:paso", requireAuth, async (req,res)=>{
  try{
    const ec=await cargarExpediente(req.params.id), paso=Number(req.params.paso);
    if(!ec) return res.status(404).json({error:"Expediente no encontrado."});
    if(!await puedeVer(req.session.usuario,ec)) return res.status(403).json({error:"Sin acceso."});
    if(ec.estado!=="en_curso") return res.status(409).json({error:"El expediente está cerrado. Solo administración puede reabrirlo."});
    if(!Number.isInteger(paso)||paso<1||paso>7) return res.status(400).json({error:"Paso inválido."});
    if(paso>1){
      const anterior=await pool.query("SELECT completado FROM expedientes_conducta_pasos WHERE expediente_id=$1 AND paso=$2",[ec.id,paso-1]);
      if(!anterior.rows[0]?.completado) return res.status(409).json({error:`Complete el paso ${paso-1} antes de avanzar.`});
    }
    if(paso>=4){
      const tipoComite=await tipoComiteActivo();
      const a=await pool.query(`SELECT COUNT(*)::int AS n FROM expedientes_conducta_aprobaciones a
        JOIN funciones_institucionales fi ON fi.usuario_id=a.usuario_id AND fi.tipo=$2
        WHERE a.expediente_id=$1`,[ec.id,tipoComite]);
      if(a.rows[0].n<1) return res.status(409).json({error:"El paso 3 requiere la aprobación de al menos un miembro del Comité de Evaluación."});
    }
    const contenido=req.body.contenido&&typeof req.body.contenido==='object'?{...req.body.contenido}:{};
    const completado=!!req.body.completado;
    if([1,5,6].includes(paso) && contenido.encargado_id){
      const enc=await pool.query(`SELECT id,nombre,primer_apellido,segundo_apellido,parentesco,cedula
        FROM encargados WHERE id=$1 AND estudiante_id=$2`,[Number(contenido.encargado_id),ec.estudiante_id]);
      if(!enc.rows.length) return res.status(400).json({error:"Seleccione una persona encargada registrada para este estudiante."});
      const x=enc.rows[0];
      contenido.encargado_id=Number(x.id);
      contenido.recibe=[x.nombre,x.primer_apellido,x.segundo_apellido].filter(Boolean).join(" ").trim();
      contenido.parentesco=x.parentesco||"";
      if([5,6].includes(paso)) contenido.encargado_cedula=x.cedula||contenido.encargado_cedula||"";
    }else if([1,5,6].includes(paso) && completado && !String(contenido.recibe||"").trim()){
      return res.status(400).json({error:"El estudiante no tiene una persona encargada seleccionada."});
    }
    if(paso===2 && completado && Array.isArray(contenido.cumplidas) && contenido.cumplidas.some(x=>!x))
      return res.status(409).json({error:"Hay una acción correctiva pendiente. Use el botón de cierre con su carta de constancia."});
    if(paso===3 && !PROYECTOS.includes(contenido.proyecto)) return res.status(400).json({error:"Seleccione el tipo de trabajo TES."});
    if(paso===6 && completado && !["aprobado","no_aprobado"].includes(String(contenido.resultado||"")))
      return res.status(400).json({error:"Indique el resultado del TES para emitir el Anexo 3."});
    await pool.query(`UPDATE expedientes_conducta_pasos SET contenido=$1,completado=$2,
      completado_por=CASE WHEN $2 THEN $3 ELSE completado_por END,completado_en=CASE WHEN $2 THEN NOW() ELSE NULL END,updated_at=NOW()
      WHERE expediente_id=$4 AND paso=$5`,[contenido,completado,req.session.usuario.id,ec.id,paso]);
    if(paso===3 && ec.proyecto!==contenido.proyecto){
      await pool.query("UPDATE expedientes_conducta_tes SET proyecto=$1,updated_at=NOW() WHERE id=$2",[contenido.proyecto,ec.id]);
      await pool.query("DELETE FROM expedientes_conducta_aprobaciones WHERE expediente_id=$1",[ec.id]);
    }
    if(paso===3 && completado){
      const tipoComite=await tipoComiteActivo();
      await pool.query(`INSERT INTO notificaciones(usuario_id,tipo,mensaje)
        SELECT fi.usuario_id,'tes_aprobacion',$1 FROM funciones_institucionales fi
        WHERE fi.tipo=$3 AND NOT EXISTS(
          SELECT 1 FROM expedientes_conducta_aprobaciones a WHERE a.expediente_id=$2 AND a.usuario_id=fi.usuario_id)`,
        [`📘 El expediente de conducta N°${ec.numero}-${ec.anio} requiere su aprobación del proyecto TES.`,ec.id,tipoComite]);
    }
    res.json({ok:true});
  }catch(e){console.error("guardar paso TES",e);res.status(500).json({error:e.message});}
});

router.post("/:id/aprobar-proyecto", requireAuth, async (req,res)=>{
  try{
    const ec=await cargarExpediente(req.params.id);
    if(!ec) return res.status(404).json({error:"Expediente no encontrado."});
    if(!await esComite(req.session.usuario.id)) return res.status(403).json({error:"Solo un miembro designado del Comité de Evaluación puede aprobar."});
    const paso=await pool.query("SELECT completado FROM expedientes_conducta_pasos WHERE expediente_id=$1 AND paso=3",[ec.id]);
    if(ec.estado!=="en_curso"||!ec.proyecto||!paso.rows[0]?.completado) return res.status(409).json({error:"El profesor guía debe completar el paso 3 antes de solicitar las aprobaciones."});
    await pool.query(`INSERT INTO expedientes_conducta_aprobaciones(expediente_id,usuario_id)
      VALUES($1,$2) ON CONFLICT(expediente_id,usuario_id) DO NOTHING`,[ec.id,req.session.usuario.id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post("/:id/cerrar-causal", requireAuth, async (req,res)=>{
  try{
    const ec=await cargarExpediente(req.params.id), causal=String(req.body.causal||"");
    if(!ec) return res.status(404).json({error:"Expediente no encontrado."});
    if(!await puedeVer(req.session.usuario,ec)) return res.status(403).json({error:"Sin acceso."});
    if(causal==="accion_pendiente"){
      await pool.query(`UPDATE expedientes_conducta_tes SET estado='cerrado_accion_pendiente',motivo_cierre=$1,
        cerrado_por=$2,cerrado_en=NOW(),updated_at=NOW() WHERE id=$3`,[String(req.body.detalle||"Acción correctiva pendiente"),req.session.usuario.id,ec.id]);
      return res.json({ok:true,cerrado:true});
    }
    if(!["inasistencia","condicion_academica"].includes(causal)) return res.status(400).json({error:"Causal inválida."});
    await pool.query(`UPDATE expedientes_conducta_tes SET estado_revision=$1,motivo_cierre=$2,updated_at=NOW() WHERE id=$3`,
      [causal,String(req.body.detalle||"Remitido al Comité de Evaluación"),ec.id]);
    res.json({ok:true,cerrado:false,mensaje:"El documento quedó registrado y el caso fue remitido al Comité. No se cierra automáticamente."});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post("/:id/concluir", requireAuth, async (req,res)=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const ec=await cargarExpediente(req.params.id,client);
    if(!ec) throw new Error("Expediente no encontrado.");
    if(!await puedeVer(req.session.usuario,ec,client)) throw Object.assign(new Error("Sin acceso."),{status:403});
    const ok=await client.query("SELECT paso,completado FROM expedientes_conducta_pasos WHERE expediente_id=$1 AND paso BETWEEN 1 AND 6",[ec.id]);
    if(ok.rows.length!==6||ok.rows.some(x=>!x.completado)) throw new Error("Complete en orden los pasos 1 al 6 antes de concluir.");
    const tipoComite=await tipoComiteActivo(client);
    const ap=await client.query(`SELECT COUNT(*)::int AS n FROM expedientes_conducta_aprobaciones a
      JOIN funciones_institucionales fi ON fi.usuario_id=a.usuario_id AND fi.tipo=$2
      WHERE a.expediente_id=$1`,[ec.id,tipoComite]);
    if(ap.rows[0].n<1) throw new Error("Falta la aprobación de al menos un miembro del Comité de Evaluación.");
    const resultado=String(req.body.resultado||"");
    if(!["aprobado","no_aprobado"].includes(resultado)) throw new Error("Indique el resultado final del TES.");
    const minimo=Number(ec.nivel)<=9?65:70;
    const contenido={...(req.body.contenido||{}),resultado,calificacion:Number(req.body.calificacion)||0};
    await client.query(`UPDATE expedientes_conducta_pasos SET contenido=$1,completado=true,completado_por=$2,completado_en=NOW(),updated_at=NOW()
      WHERE expediente_id=$3 AND paso=7`,[contenido,req.session.usuario.id,ec.id]);
    await client.query(`UPDATE expedientes_conducta_tes SET estado=$1,resultado_tes=$2,calificacion_tes=$3,
      nota_final_conducta=CASE WHEN $2='aprobado' THEN $4 ELSE nota_anual END,
      cerrado_por=$5,cerrado_en=NOW(),updated_at=NOW() WHERE id=$6`,
      [resultado==='aprobado'?'cerrado_aprobado':'cerrado_no_aprobado',resultado,contenido.calificacion,minimo,req.session.usuario.id,ec.id]);
    await client.query("COMMIT");res.json({ok:true,nota_final:resultado==='aprobado'?minimo:Number(ec.nota_anual)});
  }catch(e){await client.query("ROLLBACK");res.status(e.status||400).json({error:e.message});}
  finally{client.release();}
});

router.post("/:id/reabrir", requireAuth, async (req,res)=>{
  if(!esAdmin(req.session.usuario)) return res.status(403).json({error:"Solo administración puede reabrir un expediente cerrado."});
  await pool.query(`UPDATE expedientes_conducta_tes SET estado='en_curso',reabierto_por=$1,reabierto_en=NOW(),
    motivo_reapertura=$2,cerrado_por=NULL,cerrado_en=NULL,updated_at=NOW() WHERE id=$3`,
    [req.session.usuario.id,String(req.body.motivo||"Reapertura administrativa"),req.params.id]);
  res.json({ok:true});
});

module.exports=router;
