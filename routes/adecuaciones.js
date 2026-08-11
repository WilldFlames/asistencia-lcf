const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { obtenerAnioActivo } = require("../utils/lectivo");

const TIPOS = ["no_significativa","significativa","acceso"];

async function esEncargadoApoyo(u){
  if(u?.rol === "admin") return true;
  if((u?.funciones_extra||[]).includes("comite_apoyo")) return true;
  const r=await pool.query(
    "SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='comite_apoyo'",
    [u?.id||0]
  );
  return r.rows.length>0;
}

async function requireApoyo(req,res,next){
  if(await esEncargadoApoyo(req.session.usuario)) return next();
  return res.status(403).json({error:"Solo el Comité de Apoyo puede modificar adecuaciones."});
}

async function profesorPuedeVer(u,estudianteId){
  if(await esEncargadoApoyo(u)) return true;
  const anio=await obtenerAnioActivo();
  const r=await pool.query(`
    SELECT 1
    FROM estudiantes e
    JOIN asignaciones a ON a.seccion_id=e.seccion_id
    WHERE e.id=$1 AND a.profesor_id=$2 AND COALESCE(a.anio,$3)=$3
      AND COALESCE(a.activa,true)=true
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
    LIMIT 1
  `,[estudianteId,u.id,anio]);
  return r.rows.length>0;
}

const CAMPOS_ADECUACION = `
  COALESCE(ad.no_significativa,false) AS adecuacion_no_significativa,
  COALESCE(ad.significativa,false) AS adecuacion_significativa,
  COALESCE(ad.acceso,false) AS adecuacion_acceso,
  COALESCE(ad.observacion,'') AS adecuacion_observacion,
  CONCAT_WS(', ',
    CASE WHEN ad.no_significativa THEN 'No significativa' END,
    CASE WHEN ad.significativa THEN 'Significativa' END,
    CASE WHEN ad.acceso THEN 'De acceso' END
  ) AS adecuacion_tipos`;

router.get("/secciones", requireAuth, async (req,res)=>{
  const u=req.session.usuario;
  const anio=await obtenerAnioActivo();
  if(await esEncargadoApoyo(u)){
    const r=await pool.query(`SELECT id,nombre,nivel FROM secciones
      WHERE COALESCE(activa,true)=true ORDER BY nivel,nombre`);
    return res.json(r.rows);
  }
  const r=await pool.query(`
    SELECT DISTINCT s.id,s.nombre,s.nivel
    FROM asignaciones a JOIN secciones s ON s.id=a.seccion_id
    WHERE a.profesor_id=$1 AND COALESCE(a.anio,$2)=$2 AND COALESCE(a.activa,true)=true
    ORDER BY s.nivel,s.nombre
  `,[u.id,anio]);
  res.json(r.rows);
});

router.get("/seccion/:id", requireAuth, async (req,res)=>{
  const u=req.session.usuario;
  const seccionId=Number(req.params.id);
  if(!seccionId) return res.status(400).json({error:"Sección inválida."});
  if(!(await esEncargadoApoyo(u))){
    const anio=await obtenerAnioActivo();
    const acceso=await pool.query(`SELECT 1 FROM asignaciones WHERE profesor_id=$1 AND seccion_id=$2
      AND COALESCE(anio,$3)=$3 AND COALESCE(activa,true)=true LIMIT 1`,[u.id,seccionId,anio]);
    if(!acceso.rows.length) return res.status(403).json({error:"Esta sección no pertenece a sus asignaciones."});
  }
  const r=await pool.query(`
    SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,e.subgrupo,
      s.nombre AS seccion_nombre, ${CAMPOS_ADECUACION}
    FROM estudiantes e
    JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN adecuaciones_estudiante ad ON ad.estudiante_id=e.id
    WHERE e.seccion_id=$1 AND e.activo=true AND COALESCE(e.archivado,false)=false
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre
  `,[seccionId]);
  res.json({editable:await esEncargadoApoyo(u),estudiantes:r.rows});
});

router.put("/seccion/:id", requireAuth, requireApoyo, async (req,res)=>{
  const seccionId=Number(req.params.id);
  const registros=Array.isArray(req.body?.registros)?req.body.registros:[];
  if(!seccionId || !registros.length) return res.status(400).json({error:"No hay datos para guardar."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const fila of registros){
      const estudianteId=Number(fila.estudiante_id);
      if(!estudianteId) continue;
      const pertenece=await client.query("SELECT 1 FROM estudiantes WHERE id=$1 AND seccion_id=$2",[estudianteId,seccionId]);
      if(!pertenece.rows.length) throw new Error("Un estudiante no pertenece a la sección seleccionada.");
      const noSig=fila.no_significativa===true;
      const sig=fila.significativa===true;
      const acceso=fila.acceso===true;
      await client.query(`
        INSERT INTO adecuaciones_estudiante
          (estudiante_id,no_significativa,significativa,acceso,observacion,actualizado_por,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT(estudiante_id) DO UPDATE SET
          no_significativa=EXCLUDED.no_significativa,significativa=EXCLUDED.significativa,
          acceso=EXCLUDED.acceso,observacion=EXCLUDED.observacion,
          actualizado_por=EXCLUDED.actualizado_por,updated_at=NOW()
      `,[estudianteId,noSig,sig,acceso,String(fila.observacion||"").trim(),req.session.usuario.id]);
      await client.query("UPDATE estudiantes SET adecuacion=$1 WHERE id=$2",[
        sig?"significativa":noSig?"no_significativa":"ninguna",estudianteId
      ]);
    }
    await client.query("COMMIT");
    res.json({ok:true,guardados:registros.length});
  }catch(e){
    await client.query("ROLLBACK");
    res.status(400).json({error:e.message});
  }finally{client.release();}
});

router.get("/mis-estudiantes", requireAuth, async (req,res)=>{
  const u=req.session.usuario;
  const anio=await obtenerAnioActivo();
  const r=await pool.query(`
    SELECT DISTINCT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
      s.nombre AS seccion_nombre, ${CAMPOS_ADECUACION}
    FROM asignaciones a
    JOIN estudiantes e ON e.seccion_id=a.seccion_id
      AND (COALESCE(a.subgrupo,'')='' OR UPPER(a.subgrupo)=UPPER(COALESCE(e.subgrupo,'')))
    JOIN secciones s ON s.id=e.seccion_id
    LEFT JOIN adecuaciones_estudiante ad ON ad.estudiante_id=e.id
    WHERE a.profesor_id=$1 AND COALESCE(a.anio,$2)=$2 AND COALESCE(a.activa,true)=true
      AND e.activo=true AND COALESCE(e.archivado,false)=false
    ORDER BY e.primer_apellido,e.segundo_apellido,e.nombre
  `,[u.id,anio]);
  res.json(r.rows);
});

router.post("/solicitudes", requireAuth, async (req,res)=>{
  const estudianteId=Number(req.body?.estudiante_id);
  const tipo=String(req.body?.tipo||"");
  const motivo=String(req.body?.motivo||"").trim();
  if(!estudianteId || !TIPOS.includes(tipo) || motivo.length<5)
    return res.status(400).json({error:"Estudiante, tipo y motivo son requeridos."});
  if(!(await profesorPuedeVer(req.session.usuario,estudianteId)))
    return res.status(403).json({error:"El estudiante no pertenece a sus asignaciones."});
  const pendiente=await pool.query(`SELECT 1 FROM solicitudes_adecuacion_docente
    WHERE estudiante_id=$1 AND profesor_id=$2 AND tipo=$3 AND estado='pendiente' LIMIT 1`,
    [estudianteId,req.session.usuario.id,tipo]);
  if(pendiente.rows.length) return res.status(409).json({error:"Ya existe una solicitud pendiente de este tipo."});
  const r=await pool.query(`INSERT INTO solicitudes_adecuacion_docente
    (estudiante_id,profesor_id,tipo,motivo) VALUES($1,$2,$3,$4) RETURNING id`,
    [estudianteId,req.session.usuario.id,tipo,motivo]);
  res.json({ok:true,id:r.rows[0].id});
});

router.get("/solicitudes", requireAuth, async (req,res)=>{
  const u=req.session.usuario;
  const apoyo=await esEncargadoApoyo(u);
  const params=[];
  const filtro=apoyo?"":`WHERE sol.profesor_id=$1`;
  if(!apoyo) params.push(u.id);
  const r=await pool.query(`
    SELECT sol.*,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,
      s.nombre AS seccion_nombre,u.nombre AS prof_nombre,u.primer_apellido AS prof_ap1,u.segundo_apellido AS prof_ap2,
      ur.nombre AS res_nombre,ur.primer_apellido AS res_ap1,ur.segundo_apellido AS res_ap2
    FROM solicitudes_adecuacion_docente sol
    JOIN estudiantes e ON e.id=sol.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    JOIN usuarios u ON u.id=sol.profesor_id
    LEFT JOIN usuarios ur ON ur.id=sol.resuelta_por
    ${filtro}
    ORDER BY CASE sol.estado WHEN 'pendiente' THEN 0 ELSE 1 END,sol.created_at DESC
  `,params);
  res.json({puede_resolver:apoyo,solicitudes:r.rows});
});

router.put("/solicitudes/:id/resolver", requireAuth, requireApoyo, async (req,res)=>{
  const decision=String(req.body?.decision||"");
  const respuesta=String(req.body?.respuesta||"").trim();
  if(!["aprobada","rechazada"].includes(decision)) return res.status(400).json({error:"Decisión inválida."});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query("SELECT * FROM solicitudes_adecuacion_docente WHERE id=$1 FOR UPDATE",[req.params.id]);
    if(!q.rows.length) throw new Error("Solicitud no encontrada.");
    const sol=q.rows[0];
    if(sol.estado!=="pendiente") throw new Error("La solicitud ya fue resuelta.");
    await client.query(`UPDATE solicitudes_adecuacion_docente SET estado=$1,respuesta=$2,
      resuelta_por=$3,resuelta_at=NOW(),updated_at=NOW() WHERE id=$4`,
      [decision,respuesta,req.session.usuario.id,sol.id]);
    if(decision==="aprobada"){
      const campo={no_significativa:"no_significativa",significativa:"significativa",acceso:"acceso"}[sol.tipo];
      await client.query(`
        INSERT INTO adecuaciones_estudiante(estudiante_id,${campo},observacion,actualizado_por,updated_at)
        VALUES($1,true,$2,$3,NOW())
        ON CONFLICT(estudiante_id) DO UPDATE SET ${campo}=true,
          observacion=CASE WHEN $2<>'' THEN $2 ELSE adecuaciones_estudiante.observacion END,
          actualizado_por=$3,updated_at=NOW()
      `,[sol.estudiante_id,respuesta||sol.motivo,req.session.usuario.id]);
      if(sol.tipo!=="acceso") await client.query("UPDATE estudiantes SET adecuacion=$1 WHERE id=$2",[sol.tipo,sol.estudiante_id]);
    }
    await client.query("COMMIT");
    res.json({ok:true});
  }catch(e){await client.query("ROLLBACK");res.status(400).json({error:e.message});}
  finally{client.release();}
});

router.get("/lista", requireAuth, requireApoyo, async (req,res)=>{
  const r=await pool.query(`
    SELECT e.id,e.cedula,e.nombre,e.primer_apellido,e.segundo_apellido,s.nombre AS seccion_nombre,
      ${CAMPOS_ADECUACION},ad.updated_at
    FROM adecuaciones_estudiante ad
    JOIN estudiantes e ON e.id=ad.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE e.activo=true AND COALESCE(e.archivado,false)=false
      AND (ad.no_significativa OR ad.significativa OR ad.acceso)
    ORDER BY s.nivel,s.nombre,e.primer_apellido,e.segundo_apellido,e.nombre
  `);
  res.json(r.rows);
});

module.exports=router;
