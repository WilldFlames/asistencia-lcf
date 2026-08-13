(() => {
  "use strict";

  let installPrompt = null;
  let portalFamiliasActivo = false;
  let registroSW = null;
  const parametrosIniciales = new URLSearchParams(location.search);
  const modoPersonal = location.pathname.startsWith("/personal") || parametrosIniciales.get("app") === "personal";

  const instalada = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const boton = () => document.getElementById("pwa-install-btn");

  function sincronizarBoton() {
    const btn = boton();
    const instalable = !instalada() && (Boolean(installPrompt) || esIOS());
    if (btn) btn.classList.toggle("show", portalFamiliasActivo && instalable);
    document.querySelectorAll("[data-personal-install]").forEach(elemento => {
      elemento.classList.toggle("show", modoPersonal && instalable);
    });
  }

  function cerrarModal() {
    document.getElementById("pwa-install-modal")?.remove();
  }

  function mostrarInstruccionesIOS() {
    cerrarModal();
    const nombreApp = modoPersonal ? "Personal LCF" : "LCF Familias";
    const iconoApp = modoPersonal ? "/icons/personal-lcf-192.png" : "/icons/lcf-familias-192.png";
    const modal = document.createElement("div");
    modal.id = "pwa-install-modal";
    modal.className = "pwa-modal-overlay";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "pwa-install-title");
    modal.innerHTML = `
      <div class="pwa-modal">
        <div class="pwa-modal-head">
          <img class="pwa-modal-icon" src="${iconoApp}" alt="">
          <div><h2 id="pwa-install-title">Instalar ${nombreApp}</h2><div class="pwa-modal-sub">Quedará en la pantalla de inicio como cualquier aplicación.</div></div>
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
    botonPush.hidden = tipo === "active";
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
        // Renueva la relación dispositivo-cuenta en cada ingreso. Esto corrige
        // suscripciones que el teléfono conservó pero quedaron sin asociar en BD.
        await apiPush("/api/padres/push/suscribir", "POST", { subscription:suscripcion.toJSON() });
        pintarPush({ tipo:"active", titulo:"Notificaciones activadas", detalle:"Este dispositivo recibirá avisos aunque la aplicación esté cerrada. Para verlos en pantalla, permita Avisos/Banners e Insignias en los ajustes del teléfono.", accion:"Activadas", deshabilitado:true });
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

  function estadoPersonal(texto, tipo = "") {
    const estado = document.getElementById("personal-push-status");
    if (!estado) return;
    estado.textContent = texto;
    estado.classList.toggle("ok", tipo === "ok");
    estado.classList.toggle("problem", tipo === "problem");
  }

  function botonPushPersonal() {
    return document.getElementById("personal-push-action");
  }

  async function mostrarNotificacionesPersonal() {
    if (!modoPersonal) return;
    const botonPush = botonPushPersonal();
    if (!botonPush) return;
    botonPush.hidden = false;
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !window.isSecureContext) {
      botonPush.hidden = true;
      estadoPersonal("Este navegador no permite notificaciones de la aplicación.", "problem");
      return;
    }
    if (esIOS() && !instalada()) {
      botonPush.textContent = "Instalar primero";
      estadoPersonal("En iPhone, instale Personal LCF para poder recibir avisos aunque esté cerrada.");
      return;
    }
    try {
      const configuracion = await apiPush("/api/notificaciones/push/config");
      if (!configuracion.configurada) {
        botonPush.hidden = true;
        estadoPersonal("Las claves de notificaciones todavía no están configuradas en Railway.", "problem");
        return;
      }
      if (Notification.permission === "denied") {
        botonPush.hidden = true;
        estadoPersonal("Las notificaciones están bloqueadas en los ajustes del teléfono.", "problem");
        return;
      }
      const registro = await navigator.serviceWorker.ready;
      const suscripcion = await registro.pushManager.getSubscription();
      if (suscripcion && Notification.permission === "granted") {
        await apiPush("/api/notificaciones/push/suscribir", "POST", { subscription:suscripcion.toJSON() });
        botonPush.hidden = true;
        estadoPersonal("Notificaciones activadas en este dispositivo.", "ok");
      } else {
        botonPush.textContent = "Activar notificaciones";
        estadoPersonal("Active los avisos para enterarse de citas, seguimientos y tareas importantes.");
      }
    } catch (error) {
      botonPush.textContent = "Reintentar notificaciones";
      estadoPersonal(error.message || "No se pudieron comprobar las notificaciones.", "problem");
    }
  }

  async function activarNotificacionesPersonal() {
    if (!modoPersonal) {
      location.assign("/personal?app=personal");
      return;
    }
    const botonPush = botonPushPersonal();
    if (!botonPush || botonPush.disabled) return;
    if (esIOS() && !instalada()) { mostrarInstruccionesIOS(); return; }
    botonPush.disabled = true;
    botonPush.textContent = "Activando...";
    try {
      const configuracion = await apiPush("/api/notificaciones/push/config");
      if (!configuracion.configurada || !configuracion.publicKey) throw new Error("El servicio todavía no está configurado en Railway.");
      const permiso = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permiso !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      const registro = await navigator.serviceWorker.ready;
      const existente = await registro.pushManager.getSubscription();
      const suscripcion = existente || await registro.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: claveAplicacion(configuracion.publicKey),
      });
      await apiPush("/api/notificaciones/push/suscribir", "POST", { subscription:suscripcion.toJSON() });
      await mostrarNotificacionesPersonal();
    } catch (error) {
      botonPush.textContent = "Reintentar notificaciones";
      estadoPersonal(error.message || "No se activaron las notificaciones.", "problem");
    } finally {
      botonPush.disabled = false;
    }
  }

  function aplicarIdentidadPersonal() {
    if (!modoPersonal) return;
    document.documentElement.classList.add("personal-lcf-mode");
    document.title = "Personal LCF";
    const tituloLogin = document.querySelector("#login-view .auth-box h2");
    if (tituloLogin) tituloLogin.textContent = "Personal LCF";
    const subtituloLogin = document.querySelector("#login-view .auth-sub");
    if (subtituloLogin) subtituloLogin.innerHTML = "Aplicación institucional para docentes y personal<br><em style=\"font-size:12px\">Liceo de Calle Fallas</em>";
    const cambioPadres = document.getElementById("login-toggle");
    if (cambioPadres) cambioPadres.style.display = "none";
    const avisoPadres = document.getElementById("login-modo-aviso");
    if (avisoPadres) avisoPadres.style.display = "none";
    const subtitulo = document.getElementById("topbar-page-subtitle");
    if (subtitulo) subtitulo.textContent = "Personal LCF";
    const marca = document.querySelector(".sidebar-brand-sub");
    if (marca) marca.textContent = "Personal LCF";
  }

  function iniciarPersonal() {
    const panel = document.getElementById("personal-pwa-panel");
    if (!panel || typeof ME === "undefined" || !ME) return;
    panel.hidden = false;
    const enlace = document.getElementById("personal-pwa-open");
    const botonPush = botonPushPersonal();
    if (!modoPersonal) {
      if (enlace) enlace.hidden = false;
      if (botonPush) botonPush.hidden = true;
      estadoPersonal("Abra este acceso desde el teléfono para instalar la aplicación.");
      return;
    }
    aplicarIdentidadPersonal();
    if (enlace) enlace.hidden = true;
    sincronizarBoton();
    mostrarNotificacionesPersonal();
  }

  function abrirDestinoPersonal(urlDestino = location.href) {
    if (!modoPersonal || typeof ME === "undefined" || !ME || typeof goTo !== "function") return false;
    const destino = new URL(urlDestino, location.origin);
    let pagina = destino.searchParams.get("abrir") || "dashboard";
    const referencia = Number(destino.searchParams.get("ref"));
    const botonNav = document.querySelector(`[data-page="${CSS.escape(pagina)}"]`);
    if (pagina !== "dashboard" && (!botonNav || botonNav.style.display === "none")) pagina = "dashboard";
    goTo(pagina);
    if (pagina === "alerta-temprana" && referencia && typeof atVerDetalle === "function") {
      setTimeout(() => atVerDetalle(referencia), 300);
    }
    history.replaceState({}, "", "/personal?app=personal");
    return true;
  }

  async function registrarServiceWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      registroSW = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await registroSW.update().catch(() => {});
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

  // El Service Worker usa este mensaje como respaldo cuando el teléfono ya
  // tenía la aplicación abierta al tocar una notificación.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.data?.type !== "LCF_OPEN_NOTIFICATION") return;
      const destino = new URL(event.data.url || "/?app=familias", location.origin);
      if (destino.pathname.startsWith("/personal") || destino.searchParams.get("app") === "personal") {
        window.focus();
        if (!abrirDestinoPersonal(destino.href)) location.assign(destino.href);
        return;
      }
      const tab = destino.searchParams.get("abrir");
      if (typeof window.ppTab === "function" && tab) {
        window.focus();
        window.ppTab(tab);
        history.replaceState({}, "", "/?app=familias");
      } else {
        location.assign(destino.href);
      }
    });
  }

  function limpiarBurbujaAlAbrir() {
    if (modoPersonal) return;
    if (document.visibilityState !== "visible") return;
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
  }
  document.addEventListener("visibilitychange", limpiarBurbujaAlAbrir);
  window.addEventListener("focus", limpiarBurbujaAlAbrir);

  window.LCFPWA = {
    instalar,
    alternarNotificaciones,
    mostrarNotificacionesPadres,
    activarNotificacionesPersonal,
    mostrarNotificacionesPersonal,
    iniciarPersonal,
    abrirDestinoPersonal,
    mostrarInstalacionPadres() {
      portalFamiliasActivo = true;
      sincronizarBoton();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const modoFamilias = new URLSearchParams(location.search).get("app") === "familias";
    aplicarIdentidadPersonal();
    if (modoFamilias) {
      document.title = "LCF Familias";
      if (typeof toggleLoginPadres === "function" && typeof loginEsPadre !== "undefined" && loginEsPadre === false) toggleLoginPadres();
    }
    if (instalada()) document.documentElement.classList.add("pwa-standalone");
    sincronizarBoton();
    registrarServiceWorker();
  });
  window.addEventListener("LCF_PERSONAL_READY", () => {
    iniciarPersonal();
    abrirDestinoPersonal();
  });
})();
