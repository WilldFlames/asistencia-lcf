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
