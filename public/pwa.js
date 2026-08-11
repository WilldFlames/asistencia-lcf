(() => {
  "use strict";

  let installPrompt = null;
  let portalFamiliasActivo = false;
  let registroSW = null;

  const instalada = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const boton = () => document.getElementById("pwa-install-btn");

  function sincronizarBoton() {
    const btn = boton();
    if (!btn) return;
    const disponible = portalFamiliasActivo && !instalada() && (Boolean(installPrompt) || esIOS());
    btn.classList.toggle("show", disponible);
  }

  function cerrarModal() {
    document.getElementById("pwa-install-modal")?.remove();
  }

  function mostrarInstruccionesIOS() {
    cerrarModal();
    const modal = document.createElement("div");
    modal.id = "pwa-install-modal";
    modal.className = "pwa-modal-overlay";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "pwa-install-title");
    modal.innerHTML = `
      <div class="pwa-modal">
        <div class="pwa-modal-head">
          <img class="pwa-modal-icon" src="/icons/lcf-familias-192.png" alt="">
          <div><h2 id="pwa-install-title">Instalar LCF Familias</h2><div class="pwa-modal-sub">Quedará en la pantalla de inicio como cualquier aplicación.</div></div>
        </div>
        <div class="pwa-steps">
          <div class="pwa-step"><span class="pwa-step-num">1</span><span>Abra esta página en <strong>Safari</strong>.</span></div>
          <div class="pwa-step"><span class="pwa-step-num">2</span><span>Toque el botón <strong>Compartir</strong> <span aria-hidden="true">□↑</span>.</span></div>
          <div class="pwa-step"><span class="pwa-step-num">3</span><span>Seleccione <strong>Añadir a pantalla de inicio</strong> y active <strong>Abrir como app web</strong>.</span></div>
        </div>
        <div class="pwa-modal-actions"><button class="pwa-close" type="button">Entendido</button></div>
      </div>`;
    modal.querySelector(".pwa-close").addEventListener("click", cerrarModal);
    document.body.appendChild(modal);
  }

  async function instalar() {
    if (instalada()) return;
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      sincronizarBoton();
      return;
    }
    mostrarInstruccionesIOS();
  }

  function mostrarActualizacion(registration) {
    if (document.getElementById("pwa-update")) return;
    const aviso = document.createElement("div");
    aviso.id = "pwa-update";
    aviso.className = "pwa-update";
    aviso.innerHTML = `<span><strong>Nueva versión disponible</strong><br>Actualice cuando haya terminado lo que está haciendo.</span><button type="button">Actualizar</button>`;
    aviso.querySelector("button").addEventListener("click", () => registration.waiting?.postMessage({ type: "SKIP_WAITING" }));
    document.body.appendChild(aviso);
  }

  const panelPush = () => document.getElementById("pp-push-panel");

  function claveAplicacion(base64) {
    const relleno = "=".repeat((4 - base64.length % 4) % 4);
    const segura = (base64 + relleno).replace(/-/g, "+").replace(/_/g, "/");
    const datos = atob(segura);
    return Uint8Array.from([...datos].map(letra => letra.charCodeAt(0)));
  }

  async function apiPush(ruta, metodo = "GET", cuerpo = null) {
    const opciones = {
      method: metodo,
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    };
    if (cuerpo !== null) {
      opciones.headers["Content-Type"] = "application/json";
      opciones.body = JSON.stringify(cuerpo);
    }
    const respuesta = await fetch(ruta, opciones);
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) throw new Error(datos.error || "No se pudo completar la operación.");
    return datos;
  }

  function pintarPush({ tipo = "normal", titulo, detalle, accion = "Activar", deshabilitado = false }) {
    const panel = panelPush();
    if (!panel) return;
    panel.hidden = false;
    panel.classList.toggle("active", tipo === "active");
    panel.classList.toggle("problem", tipo === "problem");
    document.getElementById("pp-push-title").textContent = titulo;
    document.getElementById("pp-push-detail").textContent = detalle;
    const botonPush = document.getElementById("pp-push-action");
    botonPush.textContent = accion;
    botonPush.disabled = deshabilitado;
    botonPush.dataset.active = tipo === "active" ? "1" : "0";
  }

  async function mostrarNotificacionesPadres({ modoPrueba = false } = {}) {
    portalFamiliasActivo = true;
    const panel = panelPush();
    if (!panel) return;
    if (modoPrueba) { panel.hidden = true; return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !window.isSecureContext) {
      pintarPush({ tipo:"problem", titulo:"Notificaciones no disponibles", detalle:"Este navegador o dispositivo no permite notificaciones de la aplicación.", accion:"No disponible", deshabilitado:true });
      return;
    }
    if (esIOS() && !instalada()) {
      pintarPush({ titulo:"Instale LCF Familias para recibir avisos", detalle:"En iPhone primero debe añadir la aplicación a la pantalla de inicio.", accion:"Cómo instalar" });
      return;
    }
    try {
      const configuracion = await apiPush("/api/padres/push/config");
      if (!configuracion.configurada) {
        pintarPush({ tipo:"problem", titulo:"Notificaciones pendientes de configurar", detalle:"La institución todavía debe activar el servicio en Railway.", accion:"Pendiente", deshabilitado:true });
        return;
      }
      if (Notification.permission === "denied") {
        pintarPush({ tipo:"problem", titulo:"Notificaciones bloqueadas", detalle:"Debe permitirlas desde los ajustes de notificaciones del teléfono.", accion:"Bloqueadas", deshabilitado:true });
        return;
      }
      const registro = await navigator.serviceWorker.ready;
      const suscripcion = await registro.pushManager.getSubscription();
      if (suscripcion && Notification.permission === "granted") {
        pintarPush({ tipo:"active", titulo:"Notificaciones activadas", detalle:"Este dispositivo recibirá boletas, escapes, anuncios, citas y permisos de salida.", accion:"Desactivar" });
      } else {
        pintarPush({ titulo:"Active las notificaciones importantes", detalle:"El liceo podrá avisarle aunque la aplicación esté cerrada.", accion:"Activar" });
      }
    } catch (error) {
      pintarPush({ tipo:"problem", titulo:"No se pudo comprobar las notificaciones", detalle:error.message, accion:"Reintentar" });
    }
  }

  async function alternarNotificaciones() {
    const botonPush = document.getElementById("pp-push-action");
    if (!botonPush || botonPush.disabled) return;
    if (esIOS() && !instalada()) { mostrarInstruccionesIOS(); return; }
    botonPush.disabled = true;
    const textoAnterior = botonPush.textContent;
    botonPush.textContent = "Procesando...";
    try {
      const registro = await navigator.serviceWorker.ready;
      const existente = await registro.pushManager.getSubscription();
      if (botonPush.dataset.active === "1" && existente) {
        await apiPush("/api/padres/push/suscribir", "DELETE", { endpoint: existente.endpoint });
        await existente.unsubscribe();
        if ("clearAppBadge" in navigator) await navigator.clearAppBadge().catch(() => {});
        await mostrarNotificacionesPadres();
        return;
      }
      const configuracion = await apiPush("/api/padres/push/config");
      if (!configuracion.configurada || !configuracion.publicKey) throw new Error("El servicio todavía no está configurado en Railway.");
      const permiso = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permiso !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      const suscripcion = existente || await registro.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: claveAplicacion(configuracion.publicKey),
      });
      await apiPush("/api/padres/push/suscribir", "POST", { subscription: suscripcion.toJSON() });
      await mostrarNotificacionesPadres();
    } catch (error) {
      pintarPush({ tipo:"problem", titulo:"No se activaron las notificaciones", detalle:error.message, accion:"Reintentar" });
    } finally {
      botonPush.disabled = false;
      if (botonPush.textContent === "Procesando...") botonPush.textContent = textoAnterior;
    }
  }

  async function registrarServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      registroSW = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      if (registroSW.waiting && navigator.serviceWorker.controller) mostrarActualizacion(registroSW);
      registroSW.addEventListener("updatefound", () => {
        const worker = registroSW.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) mostrarActualizacion(registroSW);
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
    } catch (error) {
      console.warn("No se pudo activar el modo aplicación:", error);
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    sincronizarBoton();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    sincronizarBoton();
  });

  window.LCFPWA = {
    instalar,
    alternarNotificaciones,
    mostrarNotificacionesPadres,
    mostrarInstalacionPadres() {
      portalFamiliasActivo = true;
      sincronizarBoton();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const modoFamilias = new URLSearchParams(location.search).get("app") === "familias";
    if (modoFamilias) {
      document.title = "LCF Familias";
      if (typeof toggleLoginPadres === "function" && typeof loginEsPadre !== "undefined" && loginEsPadre === false) toggleLoginPadres();
    }
    if (instalada()) document.documentElement.classList.add("pwa-standalone");
    registrarServiceWorker();
  });
})();
