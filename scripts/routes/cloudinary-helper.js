// ════════════════════════════════════════════════════════════════════════
//  CLOUDINARY HELPER
// ════════════════════════════════════════════════════════════════════════
// Integración con Cloudinary para servir fotos de estudiantes desde CDN
// en vez de guardar los bytes en Postgres. Beneficios:
//   - Ahorro de espacio en la BD (~99% menos)
//   - Fotos servidas más rápido (CDN mundial)
//   - Auto-optimización de imágenes (redimensiona/comprime automáticamente)
//
// Configuración: requiere estas 3 variables de entorno en Railway:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// Si NO están seteadas, el sistema cae al modo antiguo (fotos en BD)
// para no romper nada. Esto permite deploy gradual.

let cloudinary = null;
let habilitado = false;

try {
  const cld = require("cloudinary").v2;
  if (process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET) {
    cld.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true, // URLs siempre https
    });
    cloudinary = cld;
    habilitado = true;
    console.log("☁️  Cloudinary configurado: fotos se guardarán en CDN");
  } else {
    console.log("ℹ️  Cloudinary NO configurado (faltan variables de entorno). Las fotos se guardan en la BD.");
  }
} catch (e) {
  console.warn("⚠️  Módulo cloudinary no instalado o error al cargarlo:", e.message);
  console.warn("   Las fotos seguirán guardándose en la BD hasta que se instale.");
}

// Subir una foto desde bytes o base64 dataURI.
// Retorna { url, public_id } o null si falla o si Cloudinary no está.
// El public_id se guarda como estudiantes/<id> para poder borrarla luego.
async function subirFotoEstudiante(estudianteId, imagenBytesOBase64) {
  if (!habilitado) return null;
  try {
    // Convertir bytes a data URI si viene como Buffer
    let dataUri = imagenBytesOBase64;
    if (Buffer.isBuffer(imagenBytesOBase64)) {
      dataUri = `data:image/jpeg;base64,${imagenBytesOBase64.toString("base64")}`;
    } else if (typeof imagenBytesOBase64 === "string" && !imagenBytesOBase64.startsWith("data:")) {
      dataUri = `data:image/jpeg;base64,${imagenBytesOBase64}`;
    }
    const publicId = `estudiantes/${estudianteId}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      overwrite: true,       // si ya había foto, reemplaza
      resource_type: "image",
      // Transformación al subir: máximo 800x800, calidad auto
      transformation: [
        { width: 800, height: 800, crop: "limit" },
        { quality: "auto:good" },
        { fetch_format: "auto" },
      ],
    });
    return {
      url: result.secure_url,
      public_id: result.public_id,
    };
  } catch (e) {
    console.error("Error subiendo foto a Cloudinary:", e.message);
    return null;
  }
}

// Borrar la foto de un estudiante en Cloudinary.
// No retorna error si no existía o si Cloudinary no está configurado.
async function borrarFotoEstudiante(estudianteId) {
  if (!habilitado) return { ok: false, motivo: "cloudinary_no_configurado" };
  try {
    const publicId = `estudiantes/${estudianteId}`;
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    return { ok: true };
  } catch (e) {
    console.error("Error borrando foto de Cloudinary:", e.message);
    return { ok: false, motivo: e.message };
  }
}

module.exports = {
  habilitado: () => habilitado,
  subirFotoEstudiante,
  borrarFotoEstudiante,
};
