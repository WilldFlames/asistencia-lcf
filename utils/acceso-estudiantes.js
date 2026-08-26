const { pool } = require("../db");
const { obtenerAnioActivo } = require("./lectivo");

const ROLES_ACCESO_TOTAL = new Set(["admin","auxiliar","administrativo","secretaria","bibliotecologa"]);
const ROLES_DOCENTES = new Set(["profesor","profesor_guia","orientador"]);

function accesoTotal(usuario){
  return Boolean(usuario && (
    ROLES_ACCESO_TOTAL.has(usuario.rol) ||
    (usuario.funciones_extra||[]).includes("lcf_familias")
  ));
}

async function seccionesPermitidas(usuario, db=pool){
  if(accesoTotal(usuario)) return null;
  if(!usuario || !ROLES_DOCENTES.has(usuario.rol)) return [];
  const anio=await obtenerAnioActivo(db);
  const r=await db.query(`
    SELECT DISTINCT seccion_id FROM (
      SELECT seccion_id FROM asignaciones
        WHERE profesor_id=$1 AND COALESCE(anio,$2)=$2 AND COALESCE(activa,true)=true
      UNION SELECT seccion_id FROM seccion_guia WHERE profesor_id=$1
      UNION SELECT seccion_id FROM seccion_orientador WHERE orientador_id=$1
    ) x WHERE seccion_id IS NOT NULL`,[usuario.id,anio]);
  return r.rows.map(x=>Number(x.seccion_id));
}

async function puedeAccederEstudiante(usuario, estudianteId, db=pool){
  if(accesoTotal(usuario)) return true;
  const secciones=await seccionesPermitidas(usuario,db);
  if(!secciones.length) return false;
  const r=await db.query("SELECT 1 FROM estudiantes WHERE id=$1 AND seccion_id=ANY($2::int[])",[estudianteId,secciones]);
  return Boolean(r.rows.length);
}

function exigirAccesoEstudiante(obtenerId){
  return async (req,res,next)=>{
    try{
      const id=Number(obtenerId(req));
      if(!Number.isInteger(id)||id<=0) return res.status(400).json({error:"Estudiante inválido"});
      if(!await puedeAccederEstudiante(req.session.usuario,id))
        return res.status(403).json({error:"No tiene permiso para consultar este estudiante."});
      next();
    }catch(e){next(e);}
  };
}

module.exports={accesoTotal,seccionesPermitidas,puedeAccederEstudiante,exigirAccesoEstudiante};
