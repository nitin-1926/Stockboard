"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/access";
import { addMember, archiveBucket, BucketError, createBucket, type MemberRef, removeMember, updateBucket } from "@/lib/buckets/actions";

// Thin wrappers: the actor checks live in src/lib/buckets/actions.ts. Expected failures
// come back as { error }; "Forbidden" still throws, since the UI never renders a control
// the actor can't use.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refresh(bucketId?: string) {
  revalidatePath("/buckets");
  if (bucketId) revalidatePath(`/buckets/${bucketId}`);
  revalidatePath("/holdings");
  revalidatePath("/watchlist");
}

async function expected<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BucketError) return { error: e.message };
    throw e;
  }
}

export type BucketFormResult = { ok: true; id: string } | { error: string } | null;

const fields = (fd: FormData) => ({
  name: String(fd.get("name") ?? "").slice(0, 200),
  description: String(fd.get("description") ?? "").slice(0, 1000),
  color: String(fd.get("color") ?? "chart-1"),
});

export async function createBucketAction(_prev: BucketFormResult, fd: FormData): Promise<BucketFormResult> {
  const actor = await requireActor();
  return expected(async () => {
    const b = await createBucket(actor, fields(fd));
    refresh();
    return { ok: true as const, id: b.id };
  });
}

export async function updateBucketAction(_prev: BucketFormResult, fd: FormData): Promise<BucketFormResult> {
  const actor = await requireActor();
  const id = String(fd.get("id") ?? "");
  if (!UUID.test(id)) return { error: "Bad bucket id." };
  return expected(async () => {
    await updateBucket(actor, id, fields(fd));
    refresh(id);
    return { ok: true as const, id };
  });
}

export async function archiveBucketAction(id: string) {
  const actor = await requireActor();
  if (!UUID.test(id)) throw new Error("Bad id");
  await archiveBucket(actor, id);
  refresh(id);
  // The bucket's page is gone now; the redirect's response carries the fresh list.
  redirect("/buckets");
}

export async function addMemberAction(bucketId: string, ref: MemberRef): Promise<{ created: boolean } | { error: string }> {
  const actor = await requireActor();
  const refId = "buyEventId" in ref ? ref.buyEventId : ref.watchItemId;
  if (!UUID.test(bucketId) || !UUID.test(String(refId))) return { error: "Bad id." };
  const clean: MemberRef = "buyEventId" in ref ? { buyEventId: refId } : { watchItemId: refId };
  return expected(async () => {
    const r = await addMember(actor, bucketId, clean);
    refresh(bucketId);
    return r;
  });
}

export async function removeMemberAction(bucketId: string, memberId: string) {
  const actor = await requireActor();
  if (!UUID.test(bucketId) || !UUID.test(memberId)) throw new Error("Bad id");
  await removeMember(actor, memberId);
  refresh(bucketId);
}
