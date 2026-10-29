// Web Push reminders: permission, VAPID subscription, and the server registration.
import { api } from "../api.ts";

export type ReminderState = "unsupported" | "insecure" | "denied" | "off" | "on";

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function reminderState(): Promise<ReminderState> {
  if (!window.isSecureContext) return "insecure";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

export async function enableReminders(): Promise<ReminderState> {
  if (!window.isSecureContext) return "insecure";
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(await api.pushPublicKey()),
    }));
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disableReminders(): Promise<ReminderState> {
  const sub = await currentSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

/** In-page fallback when no push subscription exists (e.g. VAPID push blocked) but permission was granted. */
export async function notifyLocally(title: string, body: string, url: string, tag: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (await currentSubscription()) return; // the service worker gets the push and shows it
  const reg = await navigator.serviceWorker?.getRegistration();
  const options: NotificationOptions = { body, tag, data: { url }, requireInteraction: true, icon: "/icon.svg" };
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);
}
