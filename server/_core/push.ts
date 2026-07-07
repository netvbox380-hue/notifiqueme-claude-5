import webpush from "web-push";
import { and, eq, inArray, sql } from "drizzle-orm";

import { ENV } from "./env";
import { getDb } from "../db";
import { deliveries, pushSubscriptions } from "../../drizzle/schema";

function ensureVapidConfigured() {
  const pub = ENV.vapidPublicKey;
  const priv = ENV.vapidPrivateKey;
  const subj = ENV.vapidSubject || "mailto:admin@localhost";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subj, pub, priv);
  return true;
}

export type PushDispatchResult = {
  sentUserIds: number[];
  failedUserIds: number[];
  skippedUserIds: number[];
  errorsByUserId: Record<number, string>;
  pushConfigured: boolean;
};

function shouldPruneSubscription(reason: unknown) {
  const statusCode = Number((reason as any)?.statusCode || (reason as any)?.status || 0);
  if (statusCode === 404 || statusCode === 410) return true;
  const msg = String((reason as any)?.body || (reason as any)?.message || reason || '').toLowerCase();
  return msg.includes('expired') || msg.includes('not registered') || msg.includes('unsubscribe') || msg.includes('invalid token');
}

export async function sendPushToUsers(params: {
  tenantId: number;
  userIds: number[];
  title: string;
  content: string;
  notificationId: number;
}) {
  const db = await getDb();
  if (!params.userIds.length) {
    return {
      sentUserIds: [],
      failedUserIds: [],
      skippedUserIds: [],
      errorsByUserId: {},
      pushConfigured: ensureVapidConfigured(),
    } satisfies PushDispatchResult;
  }

  const pushConfigured = ensureVapidConfigured();

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, params.userIds));

  const counts = await db
    .select({ userId: deliveries.userId, c: sql<int>`count(*)::int` })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.tenantId, params.tenantId),
        eq(deliveries.isRead, false),
        inArray(deliveries.userId, params.userIds)
      )
    )
    .groupBy(deliveries.userId);

  const byUser = new Map<number, number>();
  try {
    const rows: any[] = Array.isArray(counts) ? (counts as any) : ((counts as any)?.rows || []);
    for (const r of rows) byUser.set(Number(r.userId), Number(r.c) || 0);
  } catch {}

  // ✅ Descobre o deliveryId de cada usuário para ESTA notificação específica.
  // Usado pelo app pra fechar a notificação certa da bandeja quando o usuário
  // marcar como lida (badge nativo fica coerente em qualquer fabricante).
  const deliveryIdByUser = new Map<number, number>();
  try {
    const deliveryRows = await db
      .select({ id: deliveries.id, userId: deliveries.userId })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, params.tenantId),
          eq(deliveries.notificationId, params.notificationId),
          inArray(deliveries.userId, params.userIds)
        )
      );
    const rows: any[] = Array.isArray(deliveryRows) ? (deliveryRows as any) : ((deliveryRows as any)?.rows || []);
    for (const r of rows) deliveryIdByUser.set(Number(r.userId), Number(r.id));
  } catch {}

  const basePayload = {
    title: params.title,
    body: params.content,
    url: "/my-notifications",
    notificationId: params.notificationId,
  };

  const uniqueUserIds = [...new Set(params.userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  const subsByUser = new Map<number, any[]>();
  for (const sub of subs as any[]) {
    const userId = Number(sub.userId);
    if (!subsByUser.has(userId)) subsByUser.set(userId, []);
    subsByUser.get(userId)!.push(sub);
  }

  const result: PushDispatchResult = {
    sentUserIds: [],
    failedUserIds: [],
    skippedUserIds: [],
    errorsByUserId: {},
    pushConfigured,
  };

  for (const userId of uniqueUserIds) {
    const userSubs = subsByUser.get(userId) ?? [];

    if (!pushConfigured || !userSubs.length) {
      result.skippedUserIds.push(userId);
      continue;
    }

    const attempts = await Promise.allSettled(
      userSubs.map(async (s) => {
        if (!s.endpoint || !s.p256dh || !s.auth) {
          throw new Error("[PUSH] subscription inválida (campos ausentes)");
        }
        const deliveryId = deliveryIdByUser.get(userId) ?? null;
        const badgeCount = byUser.get(userId) || 0;

        // 🔎 Diagnóstico temporário: confirma exatamente o que foi enviado
        // pra cada usuário (útil pra comparar com o que o sw.js recebe).
        console.log(
          `[PUSH] enviando userId=${userId} deliveryId=${deliveryId} badgeCount=${badgeCount}`
        );

        try {
          return await webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: {
                p256dh: s.p256dh,
                auth: s.auth,
              },
            } as any,
            JSON.stringify({
              ...basePayload,
              badgeCount,
              deliveryId,
            }),
            {
              // ✅ "high": pede entrega imediata ao FCM, sem enfileirar/agrupar
              // sob Doze/economia de energia ou quando várias mensagens saem
              // em sequência rápida.
              urgency: "high",
              // 24h: tempo suficiente pra chegar quando o aparelho reconectar,
              // sem acumular indefinidamente mensagens muito antigas.
              TTL: 86400,
            }
          );
        } catch (err) {
          if (shouldPruneSubscription(err)) {
            try {
              await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, Number(s.id)));
            } catch {}
          }
          throw err;
        }
      })
    );

    const ok = attempts.some((entry) => entry.status === "fulfilled");
    if (ok) {
      result.sentUserIds.push(userId);
      continue;
    }

    const firstError = attempts.find((entry) => entry.status === "rejected");
    const errorMessage = firstError && firstError.status === "rejected"
      ? String(firstError.reason?.message || firstError.reason || "Falha ao enviar push").slice(0, 5000)
      : "Falha ao enviar push";

    const hadSubsBeforeAttempt = userSubs.length > 0;
    const allPruned = hadSubsBeforeAttempt && attempts.every((entry) => entry.status === "rejected" && shouldPruneSubscription((entry as PromiseRejectedResult).reason));

    if (allPruned) {
      result.skippedUserIds.push(userId);
      result.errorsByUserId[userId] = "Assinatura push expirada ou inválida; entregue apenas na caixa de entrada";
      continue;
    }

    result.failedUserIds.push(userId);
    result.errorsByUserId[userId] = errorMessage;
  }

  return result;
}
