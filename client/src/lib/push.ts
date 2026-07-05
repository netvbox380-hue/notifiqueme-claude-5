import { useEffect, useState } from "react";
import { registerServiceWorker } from "@/lib/pwa-register";

// client/src/lib/push.ts

export function isStandaloneMode() {
  // iOS Safari standalone
  // @ts-ignore
  const iosStandalone = typeof window !== "undefined" && (navigator as any).standalone;
  // Chrome/Android/desktop installed PWA
  const mqStandalone =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;

  return Boolean(iosStandalone || mqStandalone);
}

export function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

async function ensureServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Worker não suportado");
  }

  const host = String(window.location.hostname || "");
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const isSecure = window.location.protocol === "https:";
  if (!isSecure && !isLocal) {
    throw new Error(
      "Push só funciona em HTTPS ou localhost. Abra pelo domínio HTTPS publicado para ativar notificações."
    );
  }

  let reg =
    (await navigator.serviceWorker.getRegistration("/")) ||
    (await navigator.serviceWorker.getRegistration());

  if (!reg) {
    reg = await registerServiceWorker();
  }

  if (!reg) {
    throw new Error("Service Worker indisponível para push neste ambiente.");
  }

  await navigator.serviceWorker.ready;

  return reg;
}

export async function getOrCreatePushSubscription(publicKey: string) {
  if (!("PushManager" in window)) {
    throw new Error("Push não suportado neste navegador");
  }

  if (typeof Notification !== "undefined") {
    if (Notification.permission === "denied") {
      throw new Error("Notificações bloqueadas. Libere nas permissões do navegador.");
    }

    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        throw new Error("Permissão de notificação não concedida.");
      }
    }
  }

  const reg = await ensureServiceWorker();

  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;

  if (!publicKey) {
    throw new Error("VAPID public key ausente");
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  return sub;
}

export async function unsubscribePush() {
  if (!("serviceWorker" in navigator)) return;

  const reg =
    (await navigator.serviceWorker.getRegistration("/")) ||
    (await navigator.serviceWorker.getRegistration());

  if (!reg) return;

  await navigator.serviceWorker.ready;

  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
  }
}

// ✅ Status "de leitura" do push para uso em UI (banners, avisos etc.).
// Não pede permissão nem cria subscription — só observa o estado atual.
// A ativação em si continua sendo feita exclusivamente por getOrCreatePushSubscription,
// chamada a partir de um gesto explícito do usuário (evita duplicar esse fluxo).
export type PushStatus =
  | "checking"
  | "unsupported"
  | "ios-needs-install"
  | "denied"
  | "not-subscribed"
  | "active";

export function usePushStatus(): PushStatus {
  const [status, setStatus] = useState<PushStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const ua = navigator.userAgent.toLowerCase();
      const isIos = /iphone|ipad|ipod/.test(ua);

      if (isIos && !isStandaloneMode()) {
        if (!cancelled) setStatus("ios-needs-install");
        return;
      }

      if (
        typeof Notification === "undefined" ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      ) {
        if (!cancelled) setStatus("unsupported");
        return;
      }

      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("denied");
        return;
      }

      try {
        const reg =
          (await navigator.serviceWorker.getRegistration("/")) ||
          (await navigator.serviceWorker.getRegistration());
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (!cancelled) setStatus(sub ? "active" : "not-subscribed");
      } catch {
        if (!cancelled) setStatus("not-subscribed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
