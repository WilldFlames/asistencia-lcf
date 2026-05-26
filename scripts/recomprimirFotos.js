// scripts/recomprimirFotos.js
// Re-comprime las fotos grandes guardadas como base64 en la columna estudiantes.foto_url.
// Se ejecuta UNA SOLA VEZ al arrancar el servidor (flag en sistema_flags).
//
// SEGURIDAD:
// - Solo procesa fotos > 200 KB (las chicas se dejan tal cual)
// - Procesa una por una; si una falla, las demás siguen
// - Mantiene el formato JPEG, calidad 85%, max 600px lado más largo
// - Si la "comprimida" resulta más grande que la original, no la reemplaza
// - Loggea todo lo que hace
// - Marca el flag al terminar; nunca corre dos veces
//
// Idempotente. Si por alguna razón hay que volver a correr (ej. nuevas fotos
// pesadas subidas antes del fix), borrar la fila de sistema_flags con código
// RECOMPRIMIR_FOTOS_DONE manualmente desde la BD.

const { pool } = require("../db");

const UMBRAL_BYTES = 200 * 1024;      // 200 KB en base64 = ~150 KB en bytes reales
const MAX_LADO = 600;                  // máximo px del lado más largo
const JPEG_QUALITY = 85;
const FLAG_CODE = "RECOMPRIMIR_FOTOS_DONE";

async function recomprimirFotos() {
  console.log("\n[FOTOS] Iniciando verificación de re-compresión...");

  // 1. Verificar si ya se ejecutó
  let yaEjecutado = false;
  try {
    const f = await pool.query("SELECT valor FROM sistema_flags WHERE codigo=$1", [FLAG_CODE]);
    if (f.rows.length) {
      yaEjecutado = true;
      console.log(`[FOTOS] Re-compresión ya ejecutada anteriormente: ${f.rows[0].valor}`);
      console.log("[FOTOS] Para volver a correr, eliminar la fila de sistema_flags y reiniciar.");
      return;
    }
  } catch (e) {
    console.log("[FOTOS] La tabla sistema_flags todavía no existe, se asume primera ejecución.");
  }

  // 2. Cargar sharp en runtime (require diferido para no romper si no está instalado)
  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    console.error("[FOTOS] ⚠ No se pudo cargar 'sharp':", e.message);
    console.error("[FOTOS] Verificá que esté en package.json y que Railway corra `npm install`.");
    return;
  }

  // 3. Buscar fotos grandes
  let rows;
  try {
    const r = await pool.query(`
      SELECT id, primer_apellido, nombre, LENGTH(foto_url) AS bytes
      FROM estudiantes
      WHERE foto_url IS NOT NULL AND foto_url <> ''
        AND LENGTH(foto_url) > $1
      ORDER BY LENGTH(foto_url) DESC
    `, [UMBRAL_BYTES]);
    rows = r.rows;
  } catch (e) {
    console.error("[FOTOS] Error al buscar fotos:", e.message);
    return;
  }

  if (!rows.length) {
    console.log("[FOTOS] No hay fotos grandes que re-comprimir. ✓");
    try {
      await pool.query(
        "INSERT INTO sistema_flags (codigo, valor) VALUES ($1, $2) ON CONFLICT (codigo) DO NOTHING",
        [FLAG_CODE, `Sin fotos para procesar en ${new Date().toISOString()}`]
      );
    } catch {}
    return;
  }

  console.log(`[FOTOS] Encontradas ${rows.length} fotos grandes (>${UMBRAL_BYTES} bytes).`);
  const totalBytesAntes = rows.reduce((s, r) => s + Number(r.bytes), 0);
  console.log(`[FOTOS] Tamaño total antes: ${(totalBytesAntes / 1024 / 1024).toFixed(2)} MB`);
  console.log("[FOTOS] Procesando una por una (esto puede tardar varios minutos)...");

  let exitosas = 0;
  let saltadas = 0;
  let errores = 0;
  let totalAhorrado = 0;

  for (const row of rows) {
    try {
      // Cargar la foto base64 (sale en una query separada para no traerla toda junta)
      const full = await pool.query("SELECT foto_url FROM estudiantes WHERE id=$1", [row.id]);
      const dataUrl = full.rows[0]?.foto_url;
      if (!dataUrl) { saltadas++; continue; }

      // Extraer base64 puro (sin "data:image/...;base64,")
      const m = String(dataUrl).match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
      if (!m) {
        console.log(`[FOTOS] ⚠ Estudiante ${row.id} (${row.primer_apellido} ${row.nombre}): formato inválido, saltado`);
        saltadas++; continue;
      }
      const buffer = Buffer.from(m[1], "base64");

      // Procesar con sharp: redimensionar a max 600px (lado más largo), exportar JPEG 85%
      const procesado = await sharp(buffer, { failOn: 'none' })
        .rotate() // respeta orientación EXIF (foto vertical de celu sale derecha)
        .resize({
          width: MAX_LADO,
          height: MAX_LADO,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();

      const nuevaDataUrl = "data:image/jpeg;base64," + procesado.toString("base64");

      // Verificación de seguridad: si la nueva es más grande, no reemplazar
      const tamañoAntes = dataUrl.length;
      const tamañoDespues = nuevaDataUrl.length;
      if (tamañoDespues >= tamañoAntes) {
        console.log(`[FOTOS] · Estudiante ${row.id} (${row.primer_apellido}): ${(tamañoAntes/1024).toFixed(1)}KB → ${(tamañoDespues/1024).toFixed(1)}KB (no mejora, saltado)`);
        saltadas++; continue;
      }

      // Actualizar
      await pool.query("UPDATE estudiantes SET foto_url=$1 WHERE id=$2", [nuevaDataUrl, row.id]);
      const ahorro = tamañoAntes - tamañoDespues;
      totalAhorrado += ahorro;
      exitosas++;
      console.log(`[FOTOS] ✓ Estudiante ${row.id} (${row.primer_apellido} ${row.nombre}): ${(tamañoAntes/1024).toFixed(0)}KB → ${(tamañoDespues/1024).toFixed(0)}KB (ahorrado ${(ahorro/1024).toFixed(0)}KB)`);
    } catch (e) {
      errores++;
      console.error(`[FOTOS] ✗ Estudiante ${row.id} (${row.primer_apellido}): ${e.message}`);
    }
  }

  // 4. Resumen y marcar flag
  console.log("\n[FOTOS] ============ RESUMEN ============");
  console.log(`[FOTOS] Procesadas: ${exitosas}`);
  console.log(`[FOTOS] Saltadas:   ${saltadas}`);
  console.log(`[FOTOS] Errores:    ${errores}`);
  console.log(`[FOTOS] Ahorro total: ${(totalAhorrado / 1024 / 1024).toFixed(2)} MB`);
  console.log("[FOTOS] =================================\n");

  try {
    const resumen = `Procesadas=${exitosas} Saltadas=${saltadas} Errores=${errores} Ahorrado=${(totalAhorrado/1024/1024).toFixed(2)}MB en ${new Date().toISOString()}`;
    await pool.query(
      "INSERT INTO sistema_flags (codigo, valor) VALUES ($1, $2) ON CONFLICT (codigo) DO UPDATE SET valor=EXCLUDED.valor",
      [FLAG_CODE, resumen]
    );
    console.log("[FOTOS] Flag guardado, no volverá a ejecutarse.");
  } catch (e) {
    console.error("[FOTOS] Error guardando flag:", e.message);
  }
}

module.exports = { recomprimirFotos };
