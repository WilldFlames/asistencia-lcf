const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireRol, requireAuth } = require("../middleware/auth");
const { saveSession } = require("../middleware/security");
const { obtenerAnioActivo, obtenerPeriodoActual } = require("../utils/lectivo");
const onlyAdmin = requireRol("admin");

// La eliminación de cuentas es una atribución exclusiva del administrador
// institucional 0000000000, incluso si existen otras cuentas con rol admin.
function onlyAdmin000(req,res,next){
  const u=req.session?.usuario;
  const cedula=String(u?.cedula||"").replace(/[\s.\-/]/g,"");
  if(u?.rol==="admin" && cedula==="0000000000") return next();
  return res.status(403).json({error:"Solo el administrador principal 0000000000 puede eliminar usuarios."});
}

// ── USUARIOS ──────────────────────────────────────────────────
router.get("/usuarios", onlyAdmin, async (req, res) => {
  const r = await pool.query(
    "SELECT id,cedula,nombre,primer_apellido,segundo_apellido,email,rol,activo,primer_login FROM usuarios WHERE COALESCE(eliminado,false)=false ORDER BY primer_apellido,segundo_apellido,nombre"
  );
  res.json(r.rows);
});

// Lista de usuarios activos — accesible para secretaria (para consecutivos)
router.get("/usuarios-activos", requireAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT id,nombre,primer_apellido,segundo_apellido,rol FROM usuarios WHERE activo=true AND COALESCE(eliminado,false)=false ORDER BY primer_apellido,segundo_apellido,nombre"
  );
  res.json(r.rows);
});

router.post("/usuarios", onlyAdmin, async (req, res) => {
  const { cedula, nombre, primer_apellido, segundo_apellido, email, rol } = req.body;
  if (!cedula||!nombre||!primer_apellido||!segundo_apellido||!rol)
    return res.status(400).json({ error: "Todos los campos son requeridos" });
  try {
    // Contraseña inicial = cédula, primer_login = true
    const hash = await bcrypt.hash(cedula.trim(), 10);
    const r = await pool.query(`
      INSERT INTO usuarios (cedula,nombre,primer_apellido,segundo_apellido,email,password_hash,rol,primer_login)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id
    `, [cedula.trim(),nombre.trim(),primer_apellido.trim(),segundo_apellido.trim(),email||null,hash,rol]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "La cédula ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/usuarios/:id", onlyAdmin, async (req, res) => {
  const { nombre, primer_apellido, segundo_apellido, email, rol, activo } = req.body;
  const rolesValidos=["admin","auxiliar","orientador","profesor_guia","profesor","cocinera","secretaria","administrativo","junta","seguridad"];
  if(!rolesValidos.includes(rol)) return res.status(400).json({error:"Rol inválido"});
  const usuarioId=Number(req.params.id);
  if(!Number.isInteger(usuarioId)||usuarioId<=0) return res.status(400).json({error:"Usuario inválido"});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const anterior=await client.query("SELECT cedula,rol,activo FROM usuarios WHERE id=$1 AND COALESCE(eliminado,false)=false FOR UPDATE",[usuarioId]);
    if(!anterior.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Usuario no encontrado"});}
    const cedula=String(anterior.rows[0].cedula||"").replace(/[\s.\-/]/g,"");
    if(cedula==="0000000000" && (rol!=="admin" || activo===false)){
      await client.query("ROLLBACK");
      return res.status(400).json({error:"La cuenta institucional 0000000000 debe permanecer activa y con rol Administrador."});
    }
    await client.query(`UPDATE usuarios SET nombre=$1,primer_apellido=$2,segundo_apellido=$3,email=$4,rol=$5,activo=$6 WHERE id=$7`,
      [nombre,primer_apellido,segundo_apellido,email||null,rol,activo,usuarioId]);
    // Si cambian sus permisos o se desactiva, cualquier sesión abierta deja de
    // ser válida inmediatamente; no hay que esperar a que cierre el navegador.
    if(anterior.rows[0].rol!==rol || Boolean(anterior.rows[0].activo)!==Boolean(activo)){
      await client.query(`DELETE FROM "session" WHERE sess::jsonb #>> '{usuario,id}'=$1`,[String(usuarioId)]);
    }
    await client.query("COMMIT");
    res.json({ ok:true });
  } catch(e) { await client.query("ROLLBACK"); res.status(500).json({ error:e.message }); }
  finally{client.release();}
});

// Reiniciar contraseña → vuelve a ser la cédula, obliga cambio
router.put("/usuarios/:id/reset-password", onlyAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT cedula FROM usuarios WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const hash = await bcrypt.hash(r.rows[0].cedula, 10);
    await pool.query("UPDATE usuarios SET password_hash=$1, primer_login=true WHERE id=$2", [hash, req.params.id]);
    res.json({ ok: true, mensaje: "Contraseña reiniciada. El usuario deberá cambiarla al ingresar." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Eliminar usuario = baja segura. No se borra físicamente porque numerosas
// actuaciones oficiales conservan quién las registró. Sí se revocan de
// inmediato la sesión, las asignaciones vigentes y las funciones operativas.
router.delete("/usuarios/:id", onlyAdmin000, async (req,res)=>{
  const usuarioId=Number(req.params.id);
  if(!Number.isInteger(usuarioId) || usuarioId<=0)
    return res.status(400).json({error:"Usuario inválido."});
  if(usuarioId===Number(req.session.usuario.id))
    return res.status(400).json({error:"El administrador principal 0000000000 no puede eliminar su propia cuenta."});

  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const encontrado=await client.query(
      "SELECT id,cedula,nombre,primer_apellido,segundo_apellido FROM usuarios WHERE id=$1 AND COALESCE(eliminado,false)=false FOR UPDATE",
      [usuarioId]
    );
    if(!encontrado.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({error:"Usuario no encontrado."});
    }
    const cedulaObjetivo=String(encontrado.rows[0].cedula||"").replace(/[\s.\-/]/g,"");
    if(cedulaObjetivo==="0000000000"){
      await client.query("ROLLBACK");
      return res.status(400).json({error:"La cuenta institucional 0000000000 está protegida y no puede eliminarse."});
    }

    await client.query("UPDATE asignaciones SET activa=false WHERE profesor_id=$1 AND COALESCE(activa,true)=true",[usuarioId]);
    await client.query("UPDATE seccion_guia SET profesor_id=NULL WHERE profesor_id=$1",[usuarioId]);
    await client.query("DELETE FROM seccion_orientador WHERE orientador_id=$1",[usuarioId]);
    await client.query("DELETE FROM comedor_comite WHERE usuario_id=$1",[usuarioId]);
    await client.query("DELETE FROM matricula_comite WHERE usuario_id=$1",[usuarioId]);
    await client.query("DELETE FROM funciones_institucionales WHERE usuario_id=$1",[usuarioId]);
    await client.query(`UPDATE usuarios
      SET activo=false,eliminado=true,eliminado_at=NOW(),eliminado_por=$2
      WHERE id=$1`,[usuarioId,req.session.usuario.id]);
    // connect-pg-simple guarda el usuario dentro de sess. Al borrar esas filas
    // la persona queda fuera del sistema aun si tenía una pestaña abierta.
    await client.query(`DELETE FROM "session"
      WHERE sess::jsonb #>> '{usuario,id}'=$1`,[String(usuarioId)]);
    await client.query("COMMIT");
    res.json({ok:true,mensaje:"Usuario eliminado. Se conservó únicamente su historial institucional."});
  }catch(error){
    await client.query("ROLLBACK");
    res.status(500).json({error:"No fue posible eliminar el usuario de forma segura: "+error.message});
  }finally{client.release();}
});

// ── MATERIAS ──────────────────────────────────────────────────
router.get("/materias", async (req, res) => {
  const r = await pool.query("SELECT * FROM materias ORDER BY nombre");
  res.json(r.rows);
});

router.post("/materias", onlyAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const r = await pool.query("INSERT INTO materias (nombre) VALUES ($1) RETURNING *", [nombre.trim()]);
    res.json(r.rows[0]);
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Materia ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/materias/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM materias WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ── MODO SIMPLIFICADO ─────────────────────────────────────────────────
// El sistema tiene DOS niveles para el modo simplificado:
//
//   1. Por MATERIA  (esta función): afecta a TODOS los profes que dan la
//      materia, en CUALQUIER período. Útil para materias como Ética y
//      Valores que siempre se llevan así.
//
//   2. Por ASIGNACIÓN (router de asignaciones): solo ese profe, esa sección,
//      ESE período. Útil para casos puntuales — por ejemplo el rescate de
//      notas del I Período cuando el sistema se implementó tarde.
//
// El sistema considera que una asignación está en modo simplificado si
// CUALQUIERA de los dos está marcado.
router.put("/materias/:id/simplificado", onlyAdmin, async (req, res) => {
  const { activo } = req.body;
  await pool.query("UPDATE materias SET modo_simplificado=$1 WHERE id=$2", [!!activo, req.params.id]);
  res.json({ ok: true, modo_simplificado: !!activo });
});

router.put("/asignaciones/:id/simplificado", onlyAdmin, async (req, res) => {
  // Body acepta:
  //   - activo (bool) — encender/apagar el flag general de la asignación
  //   - periodos (array de strings) — qué periodos quedan simplificados.
  //     Si activo=true pero periodos viene vacío, asumimos el periodo actual
  //     (compat hacia atrás con UI vieja que solo manda activo).
  const { activo, periodos } = req.body;
  const periodosFinal = Array.isArray(periodos) ? periodos.filter(Boolean) : null;

  // Si manda activo=false sin lista, vaciamos los periodos y apagamos el flag.
  // Si manda lista vacía explícitamente, también apagamos.
  let activoFinal = !!activo;
  let lista = periodosFinal || [];
  if (activoFinal && lista.length === 0) {
    // Activo sin periodos → no hace nada útil. Apagamos.
    activoFinal = false;
  }
  if (!activoFinal) lista = [];

  await pool.query(
    "UPDATE asignaciones SET modo_simplificado=$1, simplificado_periodos=$2 WHERE id=$3",
    [activoFinal, lista, req.params.id]
  );
  res.json({ ok: true, modo_simplificado: activoFinal, simplificado_periodos: lista });
});

// ── SECCIONES ─────────────────────────────────────────────────
router.get("/secciones", async (req, res) => {
  const anioActivo = await obtenerAnioActivo();
  const solicitado = parseInt(req.query.anio);
  // Las secciones futuras forman parte de la preparación administrativa.
  // Los demás perfiles reciben siempre la estructura del año activo, aunque
  // intenten escribir ?anio=2027 manualmente.
  const anio = req.session?.usuario?.rol === 'admin' && solicitado ? solicitado : anioActivo;
  const r = await pool.query(`
    SELECT s.*,
      u.nombre AS guia_nombre, u.primer_apellido AS guia_ap1, u.segundo_apellido AS guia_ap2, u.id AS guia_id, u.cedula AS guia_cedula,
      o.id AS orient_id, o.nombre AS orient_nombre, o.primer_apellido AS orient_ap1, o.segundo_apellido AS orient_ap2, o.cedula AS orient_cedula
    FROM secciones s
    JOIN secciones_anio san ON san.seccion_id=s.id AND san.anio=$1 AND san.activa=true
    LEFT JOIN seccion_guia_anio sg ON sg.seccion_id=s.id AND sg.anio=$1
    LEFT JOIN usuarios u ON u.id=sg.profesor_id
    LEFT JOIN seccion_orientador_anio so2 ON so2.seccion_id=s.id AND so2.anio=$1
    LEFT JOIN usuarios o ON o.id=so2.orientador_id
    ORDER BY s.nivel, s.nombre
  `, [anio]);
  res.json(r.rows);
});

// ── DIAGNÓSTICO TEMPORAL: ver TODAS las asignaciones de un profe ──────────
// GET /api/admin/diagnostico-asignaciones/:profesor_id
// Devuelve TODAS las filas crudas de la tabla asignaciones para ese profe,
// SIN filtros de período ni herencia. Solo admin.
// ── ESTADO DE SUBGRUPOS POR SECCIÓN (para admin) ──────────────────────────
// Devuelve, por cada sección, cuántos estudiantes hay con A, con B y sin subgrupo.
// Sirve para verificar visualmente antes de invertir subgrupos.
router.get("/subgrupos-estado", onlyAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT s.id AS seccion_id, s.nombre AS seccion_nombre, s.nivel,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'A')::int AS cant_a,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(e.subgrupo,'')) = 'B')::int AS cant_b,
      COUNT(*) FILTER (WHERE COALESCE(e.subgrupo,'') = '')::int AS sin_subgrupo,
      COUNT(*)::int AS total
    FROM secciones s
    LEFT JOIN estudiantes e ON e.seccion_id = s.id
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    GROUP BY s.id, s.nombre, s.nivel
    HAVING COUNT(*) > 0
    ORDER BY s.nivel, s.nombre
  `);
  res.json(r.rows);
});

// ── INVERTIR A↔B EN UNA SECCIÓN (solo admin, con confirmación) ────────────
// Los estudiantes con subgrupo A pasan a B y viceversa. Los sin subgrupo se quedan igual.
// Registra en la tabla intercambios_periodo para auditoría.
router.post("/subgrupos-invertir/:seccion_id", onlyAdmin, async (req, res) => {
  const seccionId = parseInt(req.params.seccion_id);
  if(!seccionId) return res.status(400).json({ error: "Sección inválida" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Contar antes para reporte
    const antes = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = 'A')::int AS cant_a,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(subgrupo,'')) = 'B')::int AS cant_b
      FROM estudiantes
      WHERE seccion_id=$1 AND activo=true AND (archivado=false OR archivado IS NULL)
    `, [seccionId]);
    // Invertir (los sin subgrupo o con otro valor no se tocan)
    await client.query(`
      UPDATE estudiantes SET subgrupo = CASE
        WHEN UPPER(subgrupo) = 'A' THEN 'B'
        WHEN UPPER(subgrupo) = 'B' THEN 'A'
        ELSE subgrupo
      END
      WHERE seccion_id=$1 AND activo=true AND (archivado=false OR archivado IS NULL)
        AND UPPER(COALESCE(subgrupo,'')) IN ('A','B')
    `, [seccionId]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      seccion_id: seccionId,
      antes: antes.rows[0],
      despues: { cant_a: antes.rows[0].cant_b, cant_b: antes.rows[0].cant_a }
    });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LCF FAMILIAS (portal de encargados)
//  Solo el administrador y las personas asignadas expresamente a la función
//  institucional "lcf_familias" pueden administrar estas cuentas. Consultar
//  la BD en cada petición revoca el permiso de inmediato al quitar la función.
// ═══════════════════════════════════════════════════════════════════════════
async function canGestionarPadres(req,res,next){
  const u=req.session?.usuario;
  if(!u) return res.status(401).json({error:"No autorizado"});
  if(u.rol==="admin") return next();
  try{
    const r=await pool.query(
      "SELECT 1 FROM funciones_institucionales WHERE usuario_id=$1 AND tipo='lcf_familias'",
      [u.id]
    );
    if(r.rows.length) return next();
    return res.status(403).json({error:"Sin permisos para LCF Familias."});
  }catch(error){return next(error);}
}
const canAdministrarSeguridadPadres = canGestionarPadres;

function limpiarCed(c){ return String(c||'').replace(/[\s\-.\/\\]/g,''); }

// Vista de prueba del portal de familias. Conserva la sesion administrativa
// y no modifica contrasenas ni sesiones reales de las familias.
router.post("/padres/:cedula/vista-prueba", onlyAdmin, async (req, res) => {
  const cedula = limpiarCed(req.params.cedula);
  const encargado = await pool.query(`
    SELECT nombre, primer_apellido, segundo_apellido
    FROM encargados
    WHERE REPLACE(REPLACE(REPLACE(cedula,'-',''),'.',''),' ','')=$1
    ORDER BY COALESCE(es_principal,false) DESC, id
    LIMIT 1
  `, [cedula]);
  if(!encargado.rows.length)
    return res.status(404).json({ error: "Encargado no encontrado." });

  const hijos = await pool.query(`
    SELECT DISTINCT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      e.seccion_id, s.nombre AS seccion_nombre
    FROM encargados enc
    JOIN estudiantes e ON e.id=enc.estudiante_id
    LEFT JOIN secciones s ON s.id=e.seccion_id
    WHERE REPLACE(REPLACE(REPLACE(enc.cedula,'-',''),'.',''),' ','')=$1
      AND COALESCE(enc.es_principal,false)=true
      AND e.activo=true AND (e.archivado=false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [cedula]);
  if(!hijos.rows.length)
    return res.status(404).json({ error: "El encargado no tiene estudiantes activos asociados." });

  const datos = encargado.rows[0];
  const padre = {
    cedula,
    nombre: datos.nombre || "",
    primer_apellido: datos.primer_apellido || "",
    segundo_apellido: datos.segundo_apellido || "",
    modo_prueba: true,
    administrador_id: req.session.usuario.id,
  };
  req.session.padre = padre;
  await saveSession(req);
  res.json({ ok:true, padre, hijos:hijos.rows, solo_lectura:true });
});

// Buscar padres/encargados: por cédula, nombre o apellido.
// Devuelve una fila por cédula única con la lista de hijos y estado de cuenta.
router.get("/padres/buscar", canGestionarPadres, async (req, res) => {
  const q = (req.query.q || '').trim();
  if(q.length < 2) return res.json([]);
  const ced = limpiarCed(q);
  const like = `%${q}%`;
  const r = await pool.query(`
    SELECT DISTINCT enc.cedula,
      MAX(enc.nombre)          FILTER (WHERE enc.cedula IS NOT NULL) AS nombre,
      MAX(enc.primer_apellido) FILTER (WHERE enc.cedula IS NOT NULL) AS primer_apellido,
      MAX(enc.segundo_apellido)FILTER (WHERE enc.cedula IS NOT NULL) AS segundo_apellido
    FROM encargados enc
    WHERE enc.cedula IS NOT NULL AND enc.cedula <> ''
      AND COALESCE(enc.es_principal,false)=true
      AND (
        REPLACE(REPLACE(REPLACE(enc.cedula,'-',''),'.',''),' ','') = $1
        OR enc.nombre ILIKE $2
        OR enc.primer_apellido ILIKE $2
        OR enc.segundo_apellido ILIKE $2
      )
    GROUP BY enc.cedula
    LIMIT 30
  `, [ced, like]);
  // Para cada uno, contar hijos activos y estado de la cuenta
  const salida = [];
  for(const p of r.rows){
    const cedLimpia = limpiarCed(p.cedula);
    const hijos = await pool.query(`
      SELECT COUNT(DISTINCT e.id)::int AS c
      FROM encargados en
      JOIN estudiantes e ON e.id = en.estudiante_id
      WHERE REPLACE(REPLACE(REPLACE(en.cedula,'-',''),'.',''),' ','') = $1
        AND COALESCE(en.es_principal,false)=true
        AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    `, [cedLimpia]);
    const acc = await pool.query(`
      SELECT activo, servicio_habilitado, servicio_habilitado_at,
        primer_login, sid_activo IS NOT NULL AS sesion_activa, created_at
      FROM padres_acceso WHERE cedula = $1
    `, [cedLimpia]);
    const esPersonal = await pool.query("SELECT id FROM usuarios WHERE cedula=$1", [cedLimpia]);
    salida.push({
      cedula: p.cedula,
      nombre: p.nombre,
      primer_apellido: p.primer_apellido,
      segundo_apellido: p.segundo_apellido,
      hijos_activos: hijos.rows[0].c,
      cuenta: acc.rows[0] || null,
      es_personal: esPersonal.rows.length > 0
    });
  }
  res.json(salida);
});

// Ver los hijos de un padre específico
router.get("/padres/:cedula/hijos", canGestionarPadres, async (req, res) => {
  const cedLimpia = limpiarCed(req.params.cedula);
  const r = await pool.query(`
    SELECT DISTINCT e.id, e.cedula, e.nombre, e.primer_apellido, e.segundo_apellido,
      s.nombre AS seccion_nombre
    FROM encargados en
    JOIN estudiantes e ON e.id = en.estudiante_id
    LEFT JOIN secciones s ON s.id = e.seccion_id
    WHERE REPLACE(REPLACE(REPLACE(en.cedula,'-',''),'.',''),' ','') = $1
      AND COALESCE(en.es_principal,false)=true
      AND e.activo = true AND (e.archivado = false OR e.archivado IS NULL)
    ORDER BY e.primer_apellido, e.segundo_apellido, e.nombre
  `, [cedLimpia]);
  res.json(r.rows);
});

// Reiniciar contraseña: la deja igual a la cédula y fuerza cambio al ingresar.
router.put("/padres/:cedula/reset-password", canAdministrarSeguridadPadres, async (req, res) => {
  const cedLimpia = limpiarCed(req.params.cedula);
  const principal = await pool.query(`
    SELECT 1 FROM encargados
    WHERE REPLACE(REPLACE(REPLACE(cedula,'-',''),'.',''),' ','')=$1
      AND COALESCE(es_principal,false)=true LIMIT 1
  `, [cedLimpia]);
  if(!principal.rows.length)
    return res.status(400).json({ error:"Solo el encargado principal puede tener acceso al portal familiar." });
  // No permitir reiniciar si es personal (esa contraseña se maneja aparte)
  const esPersonal = await pool.query("SELECT id FROM usuarios WHERE cedula=$1", [cedLimpia]);
  if(esPersonal.rows.length){
    return res.status(400).json({ error: "Esta cédula pertenece a personal del liceo. Su contraseña se gestiona desde Admin → Usuarios (reset-password de usuario), no desde acá." });
  }
  const hash = await bcrypt.hash(cedLimpia, 10);
  const r = await pool.query(`
    INSERT INTO padres_acceso (cedula, password_hash, primer_login, activo, sid_activo)
    VALUES ($1, $2, true, true, NULL)
    ON CONFLICT (cedula) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          primer_login = true,
          activo = true,
          sid_activo = NULL
    RETURNING cedula
  `, [cedLimpia, hash]);
  res.json({ ok: true, mensaje: `Contraseña reiniciada a la cédula. Al ingresar, el sistema le pedirá cambiarla.`, cedula: r.rows[0].cedula });
});

// Activar / desactivar acceso de un padre
router.put("/padres/:cedula/toggle-activo", canAdministrarSeguridadPadres, async (req, res) => {
  const cedLimpia = limpiarCed(req.params.cedula);
  const r = await pool.query(`
    UPDATE padres_acceso SET activo = NOT activo, sid_activo = NULL
    WHERE cedula = $1 RETURNING activo
  `, [cedLimpia]);
  if(!r.rows.length) return res.status(404).json({ error: "No hay cuenta creada para este padre. Solo se pueden activar/desactivar cuentas que ya hayan ingresado al menos una vez." });
  res.json({ ok: true, activo: r.rows[0].activo });
});

// Habilitación comercial del portal familiar. Al habilitar por primera vez
// se crea la cuenta con contraseña inicial igual a la cédula.
router.put("/padres/:cedula/servicio", canGestionarPadres, async (req, res) => {
  const cedLimpia = limpiarCed(req.params.cedula);
  const habilitado = req.body?.habilitado === true;
  const principal = await pool.query(`
    SELECT 1 FROM encargados
    WHERE REPLACE(REPLACE(REPLACE(cedula,'-',''),'.',''),' ','')=$1
      AND COALESCE(es_principal,false)=true LIMIT 1
  `, [cedLimpia]);
  if(!principal.rows.length)
    return res.status(400).json({ error:"Solo se puede habilitar al encargado principal." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actual = await client.query("SELECT id FROM padres_acceso WHERE cedula=$1 FOR UPDATE", [cedLimpia]);
    if(!actual.rows.length){
      if(!habilitado){
        await client.query("ROLLBACK");
        return res.json({ ok:true, servicio_habilitado:false });
      }
      const hash = await bcrypt.hash(cedLimpia, 10);
      await client.query(`
        INSERT INTO padres_acceso
          (cedula,password_hash,primer_login,activo,servicio_habilitado,servicio_habilitado_at,servicio_habilitado_por)
        VALUES ($1,$2,true,true,true,NOW(),$3)
      `, [cedLimpia,hash,req.session.usuario.id]);
    } else {
      await client.query(`
        UPDATE padres_acceso
        SET servicio_habilitado=$1,
            servicio_habilitado_at=CASE WHEN $1 THEN NOW() ELSE servicio_habilitado_at END,
            servicio_habilitado_por=CASE WHEN $1 THEN $2 ELSE servicio_habilitado_por END,
            activo=CASE WHEN $1 THEN true ELSE activo END,
            sid_activo=CASE WHEN $1 THEN sid_activo ELSE NULL END
        WHERE cedula=$3
      `, [habilitado,req.session.usuario.id,cedLimpia]);
    }
    await client.query("COMMIT");
    res.json({ ok:true, servicio_habilitado:habilitado });
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error:e.message });
  } finally { client.release(); }
});

// Forzar cierre de sesión activa (útil si sospechan uso no autorizado)
router.put("/padres/:cedula/cerrar-sesion", canAdministrarSeguridadPadres, async (req, res) => {
  const cedLimpia = limpiarCed(req.params.cedula);
  await pool.query("UPDATE padres_acceso SET sid_activo = NULL WHERE cedula = $1", [cedLimpia]);
  res.json({ ok: true });
});

// ── DIAGNÓSTICO TEMPORAL: ver TODAS las asignaciones de un profe ──────────
router.get("/diagnostico-asignaciones/:profesor_id", onlyAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT a.id, a.profesor_id, a.seccion_id, a.materia_id, a.subgrupo,
      a.lecciones_semana, a.periodo, a.created_at,
      s.nombre AS seccion_nombre, s.nivel,
      m.nombre AS materia_nombre,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1
    FROM asignaciones a
    JOIN secciones s ON s.id = a.seccion_id
    JOIN materias m ON m.id = a.materia_id
    JOIN usuarios u ON u.id = a.profesor_id
    WHERE a.profesor_id = $1
    ORDER BY s.nombre, m.nombre, a.periodo, a.subgrupo
  `, [req.params.profesor_id]);
  res.json(r.rows);
});

// Búsqueda por nombre para conseguir el profesor_id fácilmente
router.get("/buscar-profe/:nombre", onlyAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT id, cedula, nombre, primer_apellido, segundo_apellido, rol
    FROM usuarios
    WHERE (nombre ILIKE $1 OR primer_apellido ILIKE $1 OR segundo_apellido ILIKE $1)
      AND rol IN ('profesor','profesor_guia')
    ORDER BY primer_apellido, nombre
    LIMIT 20
  `, [`%${req.params.nombre}%`]);
  res.json(r.rows);
});

router.put("/secciones/:id/guia", onlyAdmin, async (req, res) => {
  const { profesor_id } = req.body;
  const anio = parseInt(req.body.anio) || await obtenerAnioActivo();
  const activo = await obtenerAnioActivo();
  if (!profesor_id) {
    await pool.query("DELETE FROM seccion_guia_anio WHERE seccion_id=$1 AND anio=$2", [req.params.id, anio]);
    if(anio === activo) await pool.query("DELETE FROM seccion_guia WHERE seccion_id=$1", [req.params.id]);
    return res.json({ ok: true });
  }
  // Validar que no sea también orientador
  const esOrient = await pool.query("SELECT 1 FROM seccion_orientador_anio WHERE orientador_id=$1 AND anio=$2 LIMIT 1", [profesor_id, anio]);
  if (esOrient.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Orientador. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query(`INSERT INTO seccion_guia_anio (seccion_id,anio,profesor_id) VALUES ($1,$2,$3)
    ON CONFLICT (seccion_id,anio) DO UPDATE SET profesor_id=EXCLUDED.profesor_id`, [req.params.id, anio, profesor_id]);
  if(anio === activo) await pool.query(`INSERT INTO seccion_guia (seccion_id,profesor_id) VALUES ($1,$2)
    ON CONFLICT (seccion_id) DO UPDATE SET profesor_id=EXCLUDED.profesor_id`, [req.params.id, profesor_id]);
  res.json({ ok: true });
});

router.post("/secciones/:id/orientador", onlyAdmin, async (req, res) => {
  const { orientador_id } = req.body;
  const anio = parseInt(req.body.anio) || await obtenerAnioActivo();
  const activo = await obtenerAnioActivo();
  if (!orientador_id) {
    await pool.query("DELETE FROM seccion_orientador_anio WHERE seccion_id=$1 AND anio=$2", [req.params.id, anio]);
    if(anio === activo) await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1", [req.params.id]);
    return res.json({ ok: true });
  }
  // Validar que no sea también guía
  const esGuia = await pool.query("SELECT 1 FROM seccion_guia_anio WHERE profesor_id=$1 AND anio=$2 LIMIT 1", [orientador_id, anio]);
  if (esGuia.rows.length > 0)
    return res.status(400).json({ error: "Este profesor ya está asignado como Profesor Guía. Un profesor solo puede tener una función extra (guía O orientador, no ambas)." });
  await pool.query(`INSERT INTO seccion_orientador_anio (seccion_id,anio,orientador_id) VALUES ($1,$2,$3)
    ON CONFLICT (seccion_id,anio) DO UPDATE SET orientador_id=EXCLUDED.orientador_id`, [req.params.id, anio, orientador_id]);
  if(anio === activo){
    await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1", [req.params.id]);
    await pool.query("INSERT INTO seccion_orientador (seccion_id,orientador_id) VALUES ($1,$2)", [req.params.id, orientador_id]);
  }
  res.json({ ok: true });
});

router.delete("/secciones/:seccion_id/orientador/:orientador_id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM seccion_orientador WHERE seccion_id=$1 AND orientador_id=$2", [req.params.seccion_id, req.params.orientador_id]);
  res.json({ ok: true });
});

// ── ASIGNACIONES ──────────────────────────────────────────────
// Por defecto muestra solo las del período actual; con ?todas=1 devuelve historial completo.
async function periodoActualAdmin() {
  return (await obtenerPeriodoActual()).nombre;
}

router.get("/asignaciones", onlyAdmin, async (req, res) => {
  const todas = req.query.todas === '1';
  const periodo = await periodoActualAdmin();
  // Año lectivo: default = actual. Permite preparar el año siguiente sin
  // afectar el año en curso. Las asignaciones del año siguiente conviven con
  // las del actual en la misma tabla, filtradas por la columna `anio`.
  // Las asignaciones legacy (anio IS NULL) se consideran del año ACTUAL
  // (no del año pedido), para que al filtrar por 2027 no aparezcan las
  // viejas del 2026 que no tenían anio registrado.
  const anioActual = await obtenerAnioActivo();
  const anio = parseInt(req.query.anio) || anioActual;
  const sqlTodas = `
    SELECT a.*, COALESCE(a.periodo,'I Período') AS periodo,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.rol AS prof_rol,
      s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
      COALESCE(m.modo_simplificado, false) AS materia_modo_simplificado
    FROM asignaciones a
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN secciones_anio san ON san.seccion_id=a.seccion_id AND san.anio=$2 AND san.activa=true
    JOIN materias m ON m.id=a.materia_id
    WHERE COALESCE(a.anio, $1) = $2
    ORDER BY u.primer_apellido, s.nombre, m.nombre
  `;
  const sqlPeriodo = `
    SELECT a.*, COALESCE(a.periodo,'I Período') AS periodo,
      u.nombre AS prof_nombre, u.primer_apellido AS prof_ap1, u.rol AS prof_rol,
      s.nombre AS seccion_nombre, m.nombre AS materia_nombre,
      COALESCE(m.modo_simplificado, false) AS materia_modo_simplificado
    FROM asignaciones a
    JOIN usuarios u ON u.id=a.profesor_id
    JOIN secciones s ON s.id=a.seccion_id
    JOIN secciones_anio san ON san.seccion_id=a.seccion_id AND san.anio=$2 AND san.activa=true
    JOIN materias m ON m.id=a.materia_id
    WHERE COALESCE(a.anio, $3) = $2 AND (
      COALESCE(a.periodo,'I Período') = $1
      OR (
        COALESCE(a.periodo,'I Período') = 'I Período'
        AND NOT EXISTS (
          SELECT 1 FROM asignaciones a2
          WHERE a2.profesor_id = a.profesor_id
            AND a2.seccion_id = a.seccion_id
            AND a2.materia_id = a.materia_id
            AND COALESCE(a2.subgrupo,'') = COALESCE(a.subgrupo,'')
            AND COALESCE(a2.periodo,'I Período') = $1
            AND COALESCE(a2.anio, $3) = $2
        )
      )
    )
    ORDER BY u.primer_apellido, s.nombre, m.nombre
  `;
  const r = await pool.query(
    todas ? sqlTodas : sqlPeriodo,
    todas ? [anioActual, anio] : [periodo, anio, anioActual]
  );
  res.json(r.rows);
});

router.post("/asignaciones", onlyAdmin, async (req, res) => {
  const { profesor_id, seccion_id, materia_id, lecciones_semana, subgrupo, periodo, anio } = req.body;
  if (!profesor_id||!seccion_id||!materia_id) return res.status(400).json({ error: "Datos incompletos" });
  const anioFinal = parseInt(anio) || await obtenerAnioActivo();
  const periodoFinal = periodo || await periodoActualAdmin();
  try {
    const seccionActiva = await pool.query(`SELECT 1 FROM secciones_anio
      WHERE seccion_id=$1 AND anio=$2 AND activa=true`, [seccion_id, anioFinal]);
    if(!seccionActiva.rows.length)
      return res.status(409).json({ error:`Esa sección no está habilitada para el ${anioFinal}. Revise Configurar Año.` });
    const dup = await pool.query(`SELECT id FROM asignaciones
      WHERE profesor_id=$1 AND seccion_id=$2 AND materia_id=$3
        AND COALESCE(subgrupo,'')=COALESCE($4::text,'')
        AND COALESCE(periodo,'I Período')=$5 AND anio=$6 LIMIT 1`,
      [profesor_id,seccion_id,materia_id,subgrupo||null,periodoFinal,anioFinal]);
    if(dup.rows.length) return res.status(409).json({ error:"Asignación ya existe para ese año, período y grupo" });
    const r = await pool.query(`INSERT INTO asignaciones (profesor_id,seccion_id,materia_id,lecciones_semana,subgrupo,periodo,anio) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [profesor_id,seccion_id,materia_id,lecciones_semana||4,subgrupo||null,periodoFinal, anioFinal]);
    res.json({ ok:true, id:r.rows[0].id });
  } catch(e) {
    if (e.message.includes("unique")) return res.status(409).json({ error: "Asignación ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/asignaciones/:id", onlyAdmin, async (req, res) => {
  await pool.query("DELETE FROM asignaciones WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

router.put("/asignaciones/:id", onlyAdmin, async (req, res) => {
  const { profesor_id, seccion_id, materia_id, lecciones_semana, subgrupo } = req.body;
  if(!profesor_id || !seccion_id || !materia_id)
    return res.status(400).json({ error: "Faltan campos requeridos." });
  // Nota: NO se permite cambiar 'periodo' desde el editor manual (eso solo lo hace el módulo de intercambio)
  const r = await pool.query(
    `UPDATE asignaciones SET profesor_id=$1, seccion_id=$2, materia_id=$3,
     lecciones_semana=$4, subgrupo=$5 WHERE id=$6 RETURNING id`,
    [profesor_id, seccion_id, materia_id, lecciones_semana || 4, subgrupo || null, req.params.id]
  );
  if(!r.rows.length) return res.status(404).json({ error: "Asignación no encontrada." });
  res.json({ ok: true });
});

router.get("/profesores", async (req, res) => {
  const r = await pool.query(`SELECT id,cedula,nombre,primer_apellido,segundo_apellido,rol FROM usuarios WHERE rol IN ('profesor','profesor_guia','orientador') AND activo=true ORDER BY primer_apellido,nombre`);
  res.json(r.rows);
});

// ── DIAGNÓSTICO DE ESPACIO: cuánto ocupan las fotos en PostgreSQL ──────
// Solo admin. Reporta cuántos estudiantes tienen foto, el peso total,
// y cuántas son "grandes" (>200 KB en base64) — candidatas a re-compresión.
router.get("/diagnostico/fotos", onlyAdmin, async (req, res) => {
  try {
    // Detección: las URLs de Cloudinary empiezan con "http". Las fotos en la
    // BD como base64 empiezan con "data:". Separamos para saber cuánto ocupa
    // realmente cada tipo y decidir si vale la pena migrar/hacer VACUUM.
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> '') AS total_con_foto,
        COUNT(*) FILTER (WHERE foto_url LIKE 'http%') AS en_cloudinary,
        COUNT(*) FILTER (WHERE foto_url LIKE 'data:%') AS en_bd_base64,
        COUNT(*) AS total_estudiantes,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL), 0) AS bytes_totales,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url LIKE 'data:%'), 0) AS bytes_base64,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url LIKE 'http%'), 0) AS bytes_urls,
        COUNT(*) FILTER (WHERE LENGTH(foto_url) > 200000) AS grandes_a_recomprimir,
        COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE LENGTH(foto_url) > 200000), 0) AS bytes_grandes,
        COALESCE(AVG(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> ''), 0)::bigint AS promedio_bytes,
        COALESCE(MAX(LENGTH(foto_url)), 0) AS max_bytes
      FROM estudiantes
    `);
    const row = r.rows[0];
    let bd_total_bytes = null;
    try {
      const sz = await pool.query("SELECT pg_database_size(current_database()) AS s");
      bd_total_bytes = sz.rows[0].s;
    } catch {}

    // Estado del proceso de re-compresión
    let estadoRec = null;
    try {
      const f = await pool.query("SELECT valor FROM sistema_flags WHERE codigo='RECOMPRIMIR_FOTOS_DONE'");
      if (f.rows.length) estadoRec = f.rows[0].valor;
    } catch {}

    // Estado de Cloudinary
    const cldEnabled = require("./cloudinary-helper").habilitado();

    res.json({
      total_estudiantes:        Number(row.total_estudiantes),
      total_con_foto:           Number(row.total_con_foto),
      en_cloudinary:            Number(row.en_cloudinary),
      en_bd_base64:             Number(row.en_bd_base64),
      cloudinary_habilitado:    cldEnabled,
      bytes_totales:            Number(row.bytes_totales),
      mb_totales:               (Number(row.bytes_totales) / 1024 / 1024).toFixed(2),
      bytes_base64:             Number(row.bytes_base64),
      mb_base64:                (Number(row.bytes_base64) / 1024 / 1024).toFixed(2),
      bytes_urls:               Number(row.bytes_urls),
      kb_urls:                  (Number(row.bytes_urls) / 1024).toFixed(2),
      grandes_a_recomprimir:    Number(row.grandes_a_recomprimir),
      bytes_grandes:            Number(row.bytes_grandes),
      mb_grandes:               (Number(row.bytes_grandes) / 1024 / 1024).toFixed(2),
      promedio_kb:              (Number(row.promedio_bytes) / 1024).toFixed(1),
      max_kb:                   (Number(row.max_bytes) / 1024).toFixed(1),
      bd_total_mb:              bd_total_bytes ? (Number(bd_total_bytes) / 1024 / 1024).toFixed(2) : null,
      recompresion_estado:      estadoRec,
    });
  } catch (e) {
    console.error("diagnostico/fotos:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── MIGRAR FOTOS BASE64 → CLOUDINARY ─────────────────────────────
// Toma todas las fotos que quedaron guardadas como base64 en la BD
// (subidas antes de activar Cloudinary) y las mueve a Cloudinary,
// reemplazando el campo foto_url con la URL. Después de migrarlas todas,
// se hace VACUUM para liberar espacio real de la BD.
//
// El proceso es SEGURO: si una foto falla al subir a Cloudinary, se deja
// como está en la BD y se continúa con la siguiente. Al final devuelve
// estadísticas de cuántas se migraron y cuántas fallaron.
router.post("/migrar-fotos-cloudinary", onlyAdmin, async (req, res) => {
  const cldHelper = require("./cloudinary-helper");
  if (!cldHelper.habilitado()) {
    return res.status(400).json({
      error: "Cloudinary no está configurado. Configurá las variables CLOUDINARY_* en Railway primero."
    });
  }
  try {
    // Buscar solo las que están como base64 (no las que ya son URLs)
    const r = await pool.query(`
      SELECT id, LENGTH(foto_url) AS bytes
      FROM estudiantes
      WHERE foto_url LIKE 'data:%'
      ORDER BY LENGTH(foto_url) DESC
    `);
    const total = r.rows.length;
    if (total === 0) {
      return res.json({ ok: true, mensaje: "No hay fotos base64 para migrar.", migradas: 0, fallidas: 0, total: 0 });
    }

    console.log(`[MIGRAR-FOTOS] Empezando migración de ${total} fotos base64 a Cloudinary...`);
    let migradas = 0;
    let fallidas = 0;
    const errores = [];

    for (const fila of r.rows) {
      try {
        // Leer la foto base64 completa
        const fR = await pool.query("SELECT foto_url FROM estudiantes WHERE id=$1", [fila.id]);
        const base64 = fR.rows[0]?.foto_url;
        if (!base64 || !base64.startsWith("data:")) {
          fallidas++;
          continue;
        }
        // Subir a Cloudinary
        const result = await cldHelper.subirFotoEstudiante(fila.id, base64);
        if (result && result.url) {
          // Reemplazar en la BD con la URL corta
          await pool.query("UPDATE estudiantes SET foto_url=$1 WHERE id=$2", [result.url, fila.id]);
          migradas++;
          if (migradas % 10 === 0) {
            console.log(`[MIGRAR-FOTOS] Progreso: ${migradas}/${total}`);
          }
        } else {
          fallidas++;
          errores.push({ id: fila.id, error: "Cloudinary devolvió null" });
        }
      } catch (e) {
        fallidas++;
        errores.push({ id: fila.id, error: e.message });
        console.error(`[MIGRAR-FOTOS] Error en estudiante ${fila.id}:`, e.message);
      }
    }

    console.log(`[MIGRAR-FOTOS] Completado: ${migradas} migradas, ${fallidas} fallidas de ${total} total.`);

    res.json({
      ok: true,
      total,
      migradas,
      fallidas,
      errores: errores.slice(0, 20),  // solo primeros 20 errores
      mensaje: `Migradas ${migradas} de ${total} fotos. ${fallidas > 0 ? `${fallidas} fallaron.` : ''} Ahora podés correr VACUUM para liberar el espacio en la BD.`
    });
  } catch (e) {
    console.error("migrar-fotos-cloudinary:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── VACUUM ESTUDIANTES (recuperar espacio) ───────────────────────
// Ejecuta VACUUM FULL sobre la tabla estudiantes para recuperar el
// espacio físico ocupado por filas viejas (dead tuples). Postgres no
// libera automáticamente el espacio al hacer UPDATE, se acumula hasta
// correr un VACUUM. Sin este paso, aunque migremos las fotos, el archivo
// físico de la tabla sigue siendo grande.
// IMPORTANTE: VACUUM FULL bloquea la tabla durante la operación. Solo
// admin puede correrlo.
router.post("/vacuum-estudiantes", onlyAdmin, async (req, res) => {
  try {
    // Tamaño ANTES
    const antesR = await pool.query(`
      SELECT
        pg_total_relation_size('estudiantes') AS bytes,
        pg_size_pretty(pg_total_relation_size('estudiantes')) AS pretty
    `);
    const antesBytes = Number(antesR.rows[0].bytes);
    const antesPretty = antesR.rows[0].pretty;

    console.log(`[VACUUM] Iniciando VACUUM FULL de estudiantes (tamaño actual: ${antesPretty})...`);
    const inicio = Date.now();
    await pool.query("VACUUM FULL estudiantes");
    const duracionMs = Date.now() - inicio;

    // Tamaño DESPUÉS
    const despuesR = await pool.query(`
      SELECT
        pg_total_relation_size('estudiantes') AS bytes,
        pg_size_pretty(pg_total_relation_size('estudiantes')) AS pretty
    `);
    const despuesBytes = Number(despuesR.rows[0].bytes);
    const despuesPretty = despuesR.rows[0].pretty;
    const ahorroMB = ((antesBytes - despuesBytes) / 1024 / 1024).toFixed(2);

    console.log(`[VACUUM] Completado en ${(duracionMs/1000).toFixed(1)}s. Antes: ${antesPretty}, después: ${despuesPretty}. Ahorro: ${ahorroMB} MB`);

    res.json({
      ok: true,
      antes: antesPretty,
      despues: despuesPretty,
      ahorro_mb: ahorroMB,
      duracion_segundos: (duracionMs / 1000).toFixed(1),
      mensaje: `VACUUM completado. Recuperados ${ahorroMB} MB de espacio.`
    });
  } catch (e) {
    console.error("vacuum-estudiantes:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── BORRAR TODAS LAS FOTOS ─────────────────────────────────────────────
// Solo admin. Pone foto_url=NULL en todos los estudiantes (activos o no).
// Devuelve cuántas fotos había antes para mostrar al usuario.
// NO se hace respaldo: la idea es liberar espacio de la BD.
router.post("/borrar-fotos", onlyAdmin, async (req, res) => {
  try {
    // Conteo y peso antes
    const antes = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE foto_url IS NOT NULL AND foto_url <> '') AS cantidad,
             COALESCE(SUM(LENGTH(foto_url)) FILTER (WHERE foto_url IS NOT NULL), 0) AS bytes
      FROM estudiantes
    `);
    const cantidad = Number(antes.rows[0].cantidad);
    const bytes = Number(antes.rows[0].bytes);

    if (cantidad === 0) {
      return res.json({ ok: true, cantidad: 0, mb_liberados: "0.00", mensaje: "No había fotos para borrar." });
    }

    // Borrar
    await pool.query("UPDATE estudiantes SET foto_url=NULL WHERE foto_url IS NOT NULL");

    // VACUUM para liberar realmente el espacio físico en disco.
    // No se puede correr dentro de una transacción, lo hacemos suelto.
    try {
      await pool.query("VACUUM estudiantes");
    } catch (e) {
      // Si VACUUM falla (permisos), no es crítico — el espacio se libera con el tiempo.
      console.warn("VACUUM estudiantes:", e.message);
    }

    const u = req.session.usuario;
    console.log(`[FOTOS] Admin ${u.id} (${u.cedula}) borró ${cantidad} fotos (${(bytes/1024/1024).toFixed(2)} MB)`);

    res.json({
      ok: true,
      cantidad,
      mb_liberados: (bytes / 1024 / 1024).toFixed(2)
    });
  } catch (e) {
    console.error("borrar-fotos:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── FUNCIONES INSTITUCIONALES ──────────────────────────────────────────
router.get("/funciones-institucionales", onlyAdmin, async (req,res)=>{
  const r=await pool.query(`
    SELECT fi.id,fi.tipo,fi.usuario_id,fi.created_at,
      u.cedula,u.nombre,u.primer_apellido,u.segundo_apellido,u.rol
    FROM funciones_institucionales fi
    JOIN usuarios u ON u.id=fi.usuario_id
    ORDER BY fi.tipo,u.primer_apellido,u.segundo_apellido,u.nombre
  `);
  res.json(r.rows);
});

router.post("/funciones-institucionales", onlyAdmin, async (req,res)=>{
  const usuarioId=Number(req.body?.usuario_id);
  const tipo=String(req.body?.tipo||"");
  if(!usuarioId || !["coordinador","comite_apoyo","lcf_familias"].includes(tipo))
    return res.status(400).json({error:"Datos de asignación inválidos."});
  const usu=await pool.query("SELECT 1 FROM usuarios WHERE id=$1 AND activo=true",[usuarioId]);
  if(!usu.rows.length) return res.status(404).json({error:"Usuario activo no encontrado."});
  const r=await pool.query(`
    INSERT INTO funciones_institucionales(usuario_id,tipo,asignado_por)
    VALUES($1,$2,$3)
    ON CONFLICT(usuario_id,tipo) DO UPDATE SET asignado_por=EXCLUDED.asignado_por
    RETURNING id
  `,[usuarioId,tipo,req.session.usuario.id]);
  await pool.query(`DELETE FROM "session" WHERE sess::jsonb #>> '{usuario,id}'=$1`,[String(usuarioId)]);
  res.json({ok:true,id:r.rows[0].id});
});

router.delete("/funciones-institucionales/:id", onlyAdmin, async (req,res)=>{
  const r=await pool.query("DELETE FROM funciones_institucionales WHERE id=$1 RETURNING usuario_id",[req.params.id]);
  if(r.rows[0]) await pool.query(`DELETE FROM "session" WHERE sess::jsonb #>> '{usuario,id}'=$1`,[String(r.rows[0].usuario_id)]);
  res.json({ok:true});
});

module.exports = router;
