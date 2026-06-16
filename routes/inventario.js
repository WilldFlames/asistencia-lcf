// ════════════════════════════════════════════════════════════════════
//  INVENTARIO — Sistema de control de productos, entradas y salidas
// ════════════════════════════════════════════════════════════════════
// Permisos: solo la Junta Administrativa accede al módulo.
// Admin puede acceder técnicamente vía API pero el frontend no lo muestra.
const router = require("express").Router();
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const ROLES_INVENTARIO = ["admin","junta"];

function canInventario(req, res, next){
  const u = req.session.usuario;
  if (!u || !ROLES_INVENTARIO.includes(u.rol)) return res.status(403).json({ error: "Sin permisos para acceder al inventario." });
  next();
}

// ════════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════════
router.get("/config", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT clave, valor FROM inv_config");
    const config = {};
    r.rows.forEach(x => (config[x.clave] = x.valor));
    res.json(config);
  } catch (e) {
    if (e.code === '42P01') return res.json({});
    res.status(500).json({ error: e.message });
  }
});

router.put("/config/:clave", canInventario, async (req, res) => {
  const { valor } = req.body;
  if (!valor) return res.status(400).json({ error: "Valor requerido" });
  await pool.query(
    "INSERT INTO inv_config (clave, valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor",
    [req.params.clave, valor]
  );
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  PRODUCTOS
// ════════════════════════════════════════════════════════════════════
router.get("/productos", requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    let sql = "SELECT * FROM inv_productos WHERE activo = true";
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (codigo ILIKE $1 OR nombre ILIKE $1 OR categoria ILIKE $1)`;
    }
    sql += " ORDER BY nombre ASC";
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get("/productos/:id", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM inv_productos WHERE id=$1", [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(r.rows[0]);
});

router.get("/productos/codigo/:codigo", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM inv_productos WHERE codigo=$1 AND activo=true", [req.params.codigo.toUpperCase()]);
  if (!r.rows.length) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(r.rows[0]);
});

router.post("/productos", canInventario, async (req, res) => {
  const { codigo, nombre, descripcion, categoria, unidad, stock_actual, stock_minimo } = req.body;
  if (!codigo || !nombre) return res.status(400).json({ error: "Código y nombre son requeridos" });
  try {
    const r = await pool.query(`
      INSERT INTO inv_productos (codigo, nombre, descripcion, categoria, unidad, stock_actual, stock_minimo)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [codigo.trim().toUpperCase(), nombre.trim(), descripcion||"", categoria||"Mobiliario", unidad||"Unidad", stock_actual||0, stock_minimo||0]);
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: "El código ya existe" });
    res.status(500).json({ error: e.message });
  }
});

router.put("/productos/:id", canInventario, async (req, res) => {
  const { nombre, descripcion, categoria, unidad, stock_minimo } = req.body;
  await pool.query(`
    UPDATE inv_productos
    SET nombre=$1, descripcion=$2, categoria=$3, unidad=$4, stock_minimo=$5
    WHERE id=$6
  `, [nombre, descripcion||"", categoria||"Mobiliario", unidad||"Unidad", stock_minimo||0, req.params.id]);
  res.json({ ok: true });
});

router.delete("/productos/:id", canInventario, async (req, res) => {
  const e = await pool.query("SELECT COUNT(*)::int AS c FROM inv_entradas WHERE producto_id=$1", [req.params.id]);
  const s = await pool.query("SELECT COUNT(*)::int AS c FROM inv_salidas_detalle WHERE producto_id=$1", [req.params.id]);
  if (e.rows[0].c > 0 || s.rows[0].c > 0) {
    // Borrado lógico: lo desactivamos para preservar historial
    await pool.query("UPDATE inv_productos SET activo=false WHERE id=$1", [req.params.id]);
    return res.json({ ok: true, mensaje: "Producto desactivado (tenía movimientos)." });
  }
  await pool.query("DELETE FROM inv_productos WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  ENTRADAS
// ════════════════════════════════════════════════════════════════════
router.get("/entradas", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, p.codigo, p.nombre AS producto_nombre, p.unidad,
             u.primer_apellido AS reg_ap1, u.segundo_apellido AS reg_ap2, u.nombre AS reg_nombre
      FROM inv_entradas e
      JOIN inv_productos p ON p.id = e.producto_id
      LEFT JOIN usuarios u ON u.id = e.registrado_por
      ORDER BY e.created_at DESC
      LIMIT 200
    `);
    res.json(r.rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post("/entradas", canInventario, async (req, res) => {
  const u = req.session.usuario;
  const { producto_id, cantidad, proveedor, observaciones, fecha } = req.body;
  if (!producto_id || !cantidad) return res.status(400).json({ error: "Producto y cantidad requeridos" });
  if (cantidad < 1) return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`
      INSERT INTO inv_entradas (producto_id, cantidad, proveedor, observaciones, fecha, registrado_por)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [producto_id, cantidad, proveedor||"", observaciones||"", fecha || new Date().toISOString().slice(0,10), u.id]);
    await client.query("UPDATE inv_productos SET stock_actual = stock_actual + $1 WHERE id = $2", [cantidad, producto_id]);
    await client.query("COMMIT");
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════
//  SALIDAS  (encabezado + detalle multi-producto)
// ════════════════════════════════════════════════════════════════════
router.get("/salidas", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
             ur.primer_apellido AS retira_ap1, ur.segundo_apellido AS retira_ap2,
             ur.nombre AS retira_nombre, ur.cedula AS retira_cedula,
             ureg.primer_apellido AS reg_ap1, ureg.segundo_apellido AS reg_ap2,
             ureg.nombre AS reg_nombre, ureg.rol AS reg_rol
      FROM inv_salidas s
      LEFT JOIN usuarios ur   ON ur.id = s.usuario_retira
      LEFT JOIN usuarios ureg ON ureg.id = s.registrado_por
      ORDER BY s.created_at DESC
      LIMIT 100
    `);

    // Detalle de cada salida
    const detalleStmt = `
      SELECT sd.cantidad, p.codigo, p.nombre, p.unidad
      FROM inv_salidas_detalle sd
      JOIN inv_productos p ON p.id = sd.producto_id
      WHERE sd.salida_id = $1
    `;
    const resultado = [];
    for (const s of r.rows) {
      const det = await pool.query(detalleStmt, [s.id]);
      resultado.push({ ...s, detalle: det.rows });
    }
    res.json(resultado);
  } catch (e) {
    console.error("GET salidas:", e);
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

// Listar usuarios para que la junta elija a quién entregar.
// Solo devuelve roles que pueden retirar (no incluye cocinera ni junta).
router.get("/usuarios-retiro", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, nombre, primer_apellido, segundo_apellido, cedula, rol
      FROM usuarios
      WHERE activo = true
        AND rol IN ('profesor','profesor_guia','orientador','administrativo','secretaria','auxiliar','admin')
      ORDER BY primer_apellido, nombre
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/salidas", canInventario, async (req, res) => {
  const u = req.session.usuario;
  const { usuario_retira, persona_nombre, persona_cedula, departamento, motivo, fecha, hora, items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Debe agregar al menos un producto" });

  // Determinar quién retira
  let retiraId = usuario_retira ? +usuario_retira : null;
  let retiraNombre = (persona_nombre||"").trim();
  let retiraCedula = (persona_cedula||"").trim();
  // Si la junta seleccionó un usuario, autorrellenamos su nombre y cédula
  if (retiraId) {
    const uR = await pool.query("SELECT nombre, primer_apellido, segundo_apellido, cedula FROM usuarios WHERE id=$1", [retiraId]);
    if (!uR.rows.length) return res.status(400).json({ error: "Usuario que retira no encontrado." });
    const x = uR.rows[0];
    retiraNombre = `${x.primer_apellido||''} ${x.segundo_apellido||''} ${x.nombre||''}`.replace(/\s+/g,' ').trim();
    retiraCedula = x.cedula || "";
  }
  if (!retiraNombre) return res.status(400).json({ error: "El nombre de quien retira es requerido" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Validar items y stock
    const validados = [];
    for (const it of items) {
      if (!it.codigo || !it.cantidad || it.cantidad < 1)
        throw { status:400, error:`Fila inválida: código "${it.codigo}"` };
      const pR = await client.query("SELECT * FROM inv_productos WHERE codigo=$1 AND activo=true", [String(it.codigo).trim().toUpperCase()]);
      if (!pR.rows.length) throw { status:404, error:`Producto "${it.codigo}" no encontrado` };
      const p = pR.rows[0];
      if (p.stock_actual < it.cantidad)
        throw { status:400, error:`Stock insuficiente para "${p.nombre}". Disponible: ${p.stock_actual} ${p.unidad}` };
      validados.push({ id: p.id, cantidadSalida: it.cantidad });
    }

    const ahora = new Date();
    const fechaFinal = fecha || ahora.toISOString().slice(0,10);
    const horaFinal  = hora  || ahora.toLocaleTimeString("es-CR", { hour:"2-digit", minute:"2-digit" });

    // Encabezado
    const sR = await client.query(`
      INSERT INTO inv_salidas (usuario_retira, persona_nombre, persona_cedula, departamento, motivo, fecha, hora, registrado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [retiraId, retiraNombre, retiraCedula, departamento||"", motivo||"", fechaFinal, horaFinal, u.id]);
    const salidaId = sR.rows[0].id;

    // Detalle + descuento de stock
    for (const v of validados) {
      await client.query(`INSERT INTO inv_salidas_detalle (salida_id, producto_id, cantidad) VALUES ($1, $2, $3)`,
        [salidaId, v.id, v.cantidadSalida]);
      await client.query("UPDATE inv_productos SET stock_actual = stock_actual - $1 WHERE id = $2",
        [v.cantidadSalida, v.id]);
    }

    await client.query("COMMIT");
    res.json({ id: salidaId, ok: true, productos: validados.length });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.status && err.error) return res.status(err.status).json({ error: err.error });
    console.error("POST salidas:", err);
    res.status(500).json({ error: err.message || "Error registrando salida" });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════════════
router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const total_productos = (await pool.query("SELECT COUNT(*)::int AS c FROM inv_productos WHERE activo=true")).rows[0].c;
    const bajo_stock = (await pool.query("SELECT COUNT(*)::int AS c FROM inv_productos WHERE stock_actual <= stock_minimo AND stock_minimo > 0 AND activo=true")).rows[0].c;
    const sin_stock = (await pool.query("SELECT COUNT(*)::int AS c FROM inv_productos WHERE stock_actual = 0 AND activo=true")).rows[0].c;
    const entradas_hoy = (await pool.query("SELECT COALESCE(SUM(cantidad),0)::int AS c FROM inv_entradas WHERE DATE(created_at)=CURRENT_DATE")).rows[0].c;
    const salidas_hoy = (await pool.query(`
      SELECT COALESCE(SUM(sd.cantidad),0)::int AS c
      FROM inv_salidas_detalle sd
      JOIN inv_salidas s ON s.id = sd.salida_id
      WHERE DATE(s.created_at) = CURRENT_DATE
    `)).rows[0].c;
    const alertas = (await pool.query(`
      SELECT * FROM inv_productos
      WHERE stock_actual <= stock_minimo AND stock_minimo > 0 AND activo=true
      ORDER BY stock_actual ASC LIMIT 10
    `)).rows;
    const ultimas_salidas_q = await pool.query(`
      SELECT s.id, s.persona_nombre, s.fecha, s.hora, s.created_at
      FROM inv_salidas s
      ORDER BY s.created_at DESC LIMIT 5
    `);
    const ultimas_salidas = [];
    for (const s of ultimas_salidas_q.rows) {
      const det = await pool.query(`
        SELECT sd.cantidad, p.nombre, p.codigo
        FROM inv_salidas_detalle sd JOIN inv_productos p ON p.id=sd.producto_id
        WHERE sd.salida_id=$1`, [s.id]);
      ultimas_salidas.push({ ...s, detalle: det.rows });
    }
    res.json({ total_productos, bajo_stock, sin_stock, entradas_hoy, salidas_hoy, alertas, ultimas_salidas });
  } catch (e) {
    console.error("GET dashboard inv:", e);
    if (e.code === '42P01') return res.json({ total_productos:0, bajo_stock:0, sin_stock:0, entradas_hoy:0, salidas_hoy:0, alertas:[], ultimas_salidas:[] });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
