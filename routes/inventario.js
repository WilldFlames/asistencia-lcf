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
  // Adjuntar seriales (disponibles + entregados) para mostrar en el modal de edición
  const sR = await pool.query(`
    SELECT s.id, s.serial, s.estado, s.notas, s.created_at,
           sal.fecha AS salida_fecha, sal.persona_nombre AS salida_persona
    FROM inv_seriales s
    LEFT JOIN inv_salidas sal ON sal.id = s.salida_id
    WHERE s.producto_id = $1
    ORDER BY s.estado, s.serial
  `, [req.params.id]);
  res.json({ ...r.rows[0], seriales: sR.rows });
});

// Listar SOLO los seriales disponibles de un producto (para el select en salidas)
router.get("/productos/:id/seriales-disponibles", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, serial, notas
      FROM inv_seriales
      WHERE producto_id = $1 AND estado = 'disponible'
      ORDER BY serial
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get("/productos/codigo/:codigo", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM inv_productos WHERE codigo=$1 AND activo=true", [req.params.codigo.toUpperCase()]);
  if (!r.rows.length) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(r.rows[0]);
});

router.post("/productos", canInventario, async (req, res) => {
  const { codigo, nombre, descripcion, categoria, unidad, stock_actual, stock_minimo, seriales } = req.body;
  if (!codigo || !nombre) return res.status(400).json({ error: "Código y nombre son requeridos" });
  // Validar seriales: si los hay, deben coincidir con el stock inicial
  const serialList = Array.isArray(seriales) ? seriales.map(s => String(s||'').trim()).filter(Boolean) : [];
  if (serialList.length > 0 && serialList.length !== (stock_actual||0)) {
    return res.status(400).json({ error: `Si registrás seriales, la cantidad (${serialList.length}) debe coincidir con las unidades a registrar (${stock_actual||0}).` });
  }
  // Verificar duplicados en la lista enviada
  const dupes = serialList.filter((s, i) => serialList.indexOf(s) !== i);
  if (dupes.length) return res.status(400).json({ error: `Seriales duplicados en la lista: ${[...new Set(dupes)].join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`
      INSERT INTO inv_productos (codigo, nombre, descripcion, categoria, unidad, stock_actual, stock_minimo)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [codigo.trim().toUpperCase(), nombre.trim(), descripcion||"", categoria||"Mobiliario", unidad||"Unidad", stock_actual||0, stock_minimo||0]);
    const productoId = r.rows[0].id;
    // Insertar seriales asociados
    for (const s of serialList) {
      await client.query(`INSERT INTO inv_seriales (producto_id, serial, estado) VALUES ($1, $2, 'disponible')`,
        [productoId, s]);
    }
    await client.query("COMMIT");
    res.json({ id: productoId, ok: true, seriales_creados: serialList.length });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === '23505') return res.status(409).json({ error: "El código ya existe (o serial duplicado)" });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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
  const { producto_id, cantidad, proveedor, observaciones, fecha, seriales } = req.body;
  if (!producto_id || !cantidad) return res.status(400).json({ error: "Producto y cantidad requeridos" });
  if (cantidad < 1) return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
  // Validar seriales si vienen
  const serialList = Array.isArray(seriales) ? seriales.map(s => String(s||'').trim()).filter(Boolean) : [];
  if (serialList.length > 0 && serialList.length !== cantidad) {
    return res.status(400).json({ error: `Si registrás seriales, la cantidad (${serialList.length}) debe coincidir con las unidades que entran (${cantidad}).` });
  }
  const dupes = serialList.filter((s, i) => serialList.indexOf(s) !== i);
  if (dupes.length) return res.status(400).json({ error: `Seriales duplicados: ${[...new Set(dupes)].join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Fecha en zona Costa Rica si el cliente no la envió.
    let fechaFinal = fecha;
    if (!fechaFinal) {
      const ahoraCR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
      const yyyy = ahoraCR.getFullYear();
      const mm = String(ahoraCR.getMonth() + 1).padStart(2, '0');
      const dd = String(ahoraCR.getDate()).padStart(2, '0');
      fechaFinal = `${yyyy}-${mm}-${dd}`;
    }
    const r = await client.query(`
      INSERT INTO inv_entradas (producto_id, cantidad, proveedor, observaciones, fecha, registrado_por)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [producto_id, cantidad, proveedor||"", observaciones||"", fechaFinal, u.id]);
    const entradaId = r.rows[0].id;
    await client.query("UPDATE inv_productos SET stock_actual = stock_actual + $1 WHERE id = $2", [cantidad, producto_id]);
    // Insertar seriales nuevos
    for (const s of serialList) {
      await client.query(
        `INSERT INTO inv_seriales (producto_id, serial, estado, entrada_id) VALUES ($1, $2, 'disponible', $3)`,
        [producto_id, s, entradaId]
      );
    }
    await client.query("COMMIT");
    res.json({ id: entradaId, ok: true, seriales_creados: serialList.length });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === '23505') return res.status(409).json({ error: "Hay seriales duplicados con otros existentes." });
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

    // Detalle de cada salida (incluye serial si lo tuvo)
    const detalleStmt = `
      SELECT sd.cantidad, p.codigo, p.nombre, p.unidad, ser.serial
      FROM inv_salidas_detalle sd
      JOIN inv_productos p ON p.id = sd.producto_id
      LEFT JOIN inv_seriales ser ON ser.id = sd.serial_id
      WHERE sd.salida_id = $1
      ORDER BY p.nombre, ser.serial
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
    retiraNombre = `${x.nombre||''} ${x.primer_apellido||''} ${x.segundo_apellido||''}`.replace(/\s+/g,' ').trim();
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

      // Validar seriales si vienen en este item
      const serialIds = Array.isArray(it.serial_ids) ? it.serial_ids.map(x => +x).filter(Boolean) : [];
      if (serialIds.length > 0) {
        if (serialIds.length !== it.cantidad)
          throw { status:400, error:`En "${p.nombre}" debés seleccionar ${it.cantidad} serial(es), no ${serialIds.length}.` };
        // Verificar que todos los seriales sean del producto y estén disponibles
        const sR = await client.query(
          `SELECT id, serial FROM inv_seriales WHERE id = ANY($1::int[]) AND producto_id = $2 AND estado = 'disponible'`,
          [serialIds, p.id]
        );
        if (sR.rows.length !== serialIds.length) {
          throw { status:400, error:`Algunos seriales de "${p.nombre}" ya no están disponibles. Recargá la página.` };
        }
      }
      validados.push({ id: p.id, cantidadSalida: it.cantidad, serialIds });
    }

    // Fecha y hora SIEMPRE en zona horaria de Costa Rica.
    // El servidor corre en UTC, así que sin esto las salidas registradas
    // a las 10pm aparecerían marcadas a las 4am del día siguiente.
    const ahoraCR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
    const yyyy = ahoraCR.getFullYear();
    const mm = String(ahoraCR.getMonth() + 1).padStart(2, '0');
    const dd = String(ahoraCR.getDate()).padStart(2, '0');
    const hh = String(ahoraCR.getHours()).padStart(2, '0');
    const min = String(ahoraCR.getMinutes()).padStart(2, '0');
    // Si el cliente envió fecha/hora explícitas las respetamos; si no, las de CR.
    const fechaFinal = fecha || `${yyyy}-${mm}-${dd}`;
    const horaFinal  = hora  || `${hh}:${min}`;

    // Encabezado
    const sR = await client.query(`
      INSERT INTO inv_salidas (usuario_retira, persona_nombre, persona_cedula, departamento, motivo, fecha, hora, registrado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
    `, [retiraId, retiraNombre, retiraCedula, departamento||"", motivo||"", fechaFinal, horaFinal, u.id]);
    const salidaId = sR.rows[0].id;

    // Detalle + descuento de stock + marcar seriales como entregados
    for (const v of validados) {
      if (v.serialIds.length > 0) {
        // Una fila de detalle por cada serial entregado (cantidad=1)
        for (const sid of v.serialIds) {
          await client.query(
            `INSERT INTO inv_salidas_detalle (salida_id, producto_id, cantidad, serial_id) VALUES ($1, $2, 1, $3)`,
            [salidaId, v.id, sid]
          );
          await client.query(
            `UPDATE inv_seriales SET estado='entregado', salida_id=$1 WHERE id=$2`,
            [salidaId, sid]
          );
        }
      } else {
        // Sin seriales: una sola fila con la cantidad total
        await client.query(
          `INSERT INTO inv_salidas_detalle (salida_id, producto_id, cantidad) VALUES ($1, $2, $3)`,
          [salidaId, v.id, v.cantidadSalida]
        );
      }
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
//  GET una salida individual (para imprimir el comprobante)
// ════════════════════════════════════════════════════════════════════
router.get("/salidas/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*,
             ur.primer_apellido AS retira_ap1, ur.segundo_apellido AS retira_ap2,
             ur.nombre AS retira_nombre, ur.cedula AS retira_cedula, ur.rol AS retira_rol,
             ureg.primer_apellido AS reg_ap1, ureg.segundo_apellido AS reg_ap2,
             ureg.nombre AS reg_nombre, ureg.rol AS reg_rol
      FROM inv_salidas s
      LEFT JOIN usuarios ur   ON ur.id = s.usuario_retira
      LEFT JOIN usuarios ureg ON ureg.id = s.registrado_por
      WHERE s.id = $1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Salida no encontrada" });

    const det = await pool.query(`
      SELECT sd.cantidad, p.codigo, p.nombre, p.unidad, p.categoria, p.descripcion, ser.serial
      FROM inv_salidas_detalle sd
      JOIN inv_productos p ON p.id = sd.producto_id
      LEFT JOIN inv_seriales ser ON ser.id = sd.serial_id
      WHERE sd.salida_id = $1
      ORDER BY p.nombre, ser.serial
    `, [req.params.id]);

    res.json({ ...r.rows[0], detalle: det.rows });
  } catch (e) {
    console.error("GET salida individual:", e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  ELIMINAR SALIDA — Solo junta/admin, con justificación obligatoria
// ════════════════════════════════════════════════════════════════════
// Al eliminar:
//   1. Devolvemos el stock al producto (suma la cantidad de cada item)
//   2. Liberamos los seriales asociados (estado='disponible', salida_id=NULL)
//   3. Borramos el detalle y el encabezado (CASCADE)
// Todo en una transacción: si falla algo, nada queda inconsistente.
router.delete("/salidas/:id", canInventario, async (req, res) => {
  const { justificacion } = req.body;
  if (!justificacion || !justificacion.trim()) {
    return res.status(400).json({ error: "La justificación es obligatoria para eliminar una salida." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validar que existe
    const s = await client.query("SELECT id FROM inv_salidas WHERE id=$1", [req.params.id]);
    if (!s.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Salida no encontrada" });
    }

    // Devolver stock por cada item del detalle
    const det = await client.query(
      "SELECT producto_id, cantidad FROM inv_salidas_detalle WHERE salida_id=$1",
      [req.params.id]
    );
    for (const d of det.rows) {
      await client.query(
        "UPDATE inv_productos SET stock_actual = stock_actual + $1 WHERE id = $2",
        [d.cantidad, d.producto_id]
      );
    }

    // Liberar seriales que estaban en esta salida (volvemos a 'disponible')
    await client.query(
      `UPDATE inv_seriales SET estado='disponible', salida_id=NULL WHERE salida_id=$1`,
      [req.params.id]
    );

    // Borrar la salida (CASCADE borra el detalle automáticamente)
    await client.query("DELETE FROM inv_salidas WHERE id=$1", [req.params.id]);

    // Log para auditoría (en consola del servidor — útil si después se necesita rastrear)
    const u = req.session.usuario;
    console.log(`[INV] Salida ${req.params.id} ELIMINADA por usuario ${u.id} (${u.rol}). Justificación: "${justificacion.trim()}"`);

    await client.query("COMMIT");
    res.json({ ok: true, productos_devueltos: det.rows.length });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("DELETE salida:", e);
    res.status(500).json({ error: e.message });
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
